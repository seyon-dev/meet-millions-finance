/**
 * Employee GPS attendance and client visits (add-on 24).
 *
 * Location data about staff is sensitive, so this module is deliberately
 * narrow: a coordinate is captured at check-in, check-out and each client
 * visit, and nowhere else. There is no continuous tracking, and the API
 * exposes no way to ask where someone is now.
 *
 * A check-in outside the branch geofence is recorded as outside it, with the
 * distance — not refused. Someone working from a client's office is doing
 * their job, and an attendance system that calls that fraud gets worked
 * around rather than used.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, dayKey, secondsBetween } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertFeature } from '../services/features.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// My attendance
// ---------------------------------------------------------------------------
router.get('/today', async (ctx) => {
  const scope = scopeFor(ctx);
  const today = dayKey();
  const record = await scope.first('attendance', { user_id: ctx.userId, day: today });

  const visits = record
    ? await scope.all('gps_visits', { attendance_id: record.id }, { order: 'checked_in_at ASC', limit: 50 })
    : [];

  const branch = ctx.user.branch_id
    ? await scope.first('branches', { id: ctx.user.branch_id })
    : await scope.first('branches', { is_head_office: 1 });

  return ok({
    day: today,
    attendance: record ? toAttendance(record) : null,
    visits: visits.map(toVisit),
    branch: branch ? {
      id: branch.id,
      name: branch.name,
      geofence: branch.latitude !== null && branch.latitude !== undefined
        ? { latitude: branch.latitude, longitude: branch.longitude, radiusMetres: branch.geofence_m }
        : null,
    } : null,
    canCheckIn: !record,
    canCheckOut: !!record && !record.check_out_at,
  }, { ctx });
}, { permission: 'attendance.self' });

router.post('/check-in', async (ctx) => {
  await assertFeature(ctx, 'gps_attendance');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    latitude: { type: 'number', required: true, min: -90, max: 90 },
    longitude: { type: 'number', required: true, min: -180, max: 180 },
    accuracyMetres: { type: 'number', min: 0, max: 10000 },
    address: { type: 'string', max: 300 },
    notes: { type: 'text', max: 500 },
  });

  const today = dayKey();
  const existing = await scope.first('attendance', { user_id: ctx.userId, day: today });
  if (existing) throw new ConflictError('You have already checked in today.');

  const branch = ctx.user.branch_id
    ? await scope.first('branches', { id: ctx.user.branch_id })
    : await scope.first('branches', { is_head_office: 1 });

  const fence = geofenceCheck(branch, input.latitude, input.longitude);

  const record = await scope.insert('attendance', {
    id: ID.attendance(),
    user_id: ctx.userId,
    branch_id: branch?.id ?? null,
    day: today,
    check_in_at: nowIso(),
    check_in_lat: input.latitude,
    check_in_lng: input.longitude,
    check_in_accuracy: input.accuracyMetres ?? null,
    check_in_address: input.address ?? null,
    check_in_within_geofence: fence.within ? 1 : 0,
    worked_minutes: 0,
    travel_km: 0,
    visit_count: 0,
    status: 'present',
    notes: input.notes ?? null,
  });

  return created({
    attendance: toAttendance(record),
    geofence: fence,
    // Recorded as-is. Working away from the office is normal; the record says
    // where, and a manager can read it if it matters.
    note: fence.within === false
      ? `Checked in ${fence.distanceMetres} m from ${branch?.name ?? 'your branch'}, which is outside its ${fence.radiusMetres} m geofence. This is recorded, not refused.`
      : null,
  }, { ctx });
}, { permission: 'attendance.self' });

router.post('/check-out', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    latitude: { type: 'number', min: -90, max: 90 },
    longitude: { type: 'number', min: -180, max: 180 },
    address: { type: 'string', max: 300 },
    notes: { type: 'text', max: 500 },
  });

  const today = dayKey();
  const record = await scope.first('attendance', { user_id: ctx.userId, day: today });
  if (!record) throw new ConflictError('You have not checked in today.');
  if (record.check_out_at) throw new ConflictError('You have already checked out today.');

  const branch = record.branch_id ? await scope.first('branches', { id: record.branch_id }) : null;
  const fence = input.latitude !== null && input.latitude !== undefined
    ? geofenceCheck(branch, input.latitude, input.longitude)
    : { within: null, distanceMetres: null, radiusMetres: null };

  const workedMinutes = Math.max(0, Math.round(secondsBetween(record.check_in_at, nowIso()) / 60));
  const visits = await scope.all('gps_visits', { attendance_id: record.id }, { limit: 100 });

  await scope.update('attendance', record.id, {
    check_out_at: nowIso(),
    check_out_lat: input.latitude ?? null,
    check_out_lng: input.longitude ?? null,
    check_out_address: input.address ?? null,
    check_out_within_geofence: fence.within === null ? null : (fence.within ? 1 : 0),
    worked_minutes: workedMinutes,
    visit_count: visits.length,
    travel_km: estimateTravelKm(record, visits, input),
    notes: input.notes ?? record.notes,
  });

  const fresh = await scope.first('attendance', { id: record.id });
  return ok({
    attendance: toAttendance(fresh),
    workedMinutes,
    workedLabel: `${Math.floor(workedMinutes / 60)}h ${workedMinutes % 60}m`,
    visits: visits.length,
  }, { ctx });
}, { permission: 'attendance.self' });

/** A client visit, logged from the field. */
router.post('/visits', async (ctx) => {
  await assertFeature(ctx, 'gps_attendance');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    clientId: { type: 'id', required: true },
    purpose: { type: 'string', max: 200 },
    latitude: { type: 'number', required: true, min: -90, max: 90 },
    longitude: { type: 'number', required: true, min: -180, max: 180 },
    accuracyMetres: { type: 'number', min: 0, max: 10000 },
    address: { type: 'string', max: 300 },
    notes: { type: 'text', max: 1000 },
    documentsCollected: { type: 'int', min: 0, max: 500 },
  });

  const today = dayKey();
  const attendance = await scope.first('attendance', { user_id: ctx.userId, day: today });
  if (!attendance) throw new ConflictError('Check in before logging a visit.');

  const client = await scope.getOrFail('clients', input.clientId, { resource: 'Client' });

  const visit = await scope.insert('gps_visits', {
    id: ID.visit(),
    attendance_id: attendance.id,
    user_id: ctx.userId,
    client_id: client.id,
    purpose: input.purpose ?? null,
    checked_in_at: nowIso(),
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_m: input.accuracyMetres ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
    documents_collected: input.documentsCollected ?? 0,
  });

  await scope.update('attendance', attendance.id, {
    visit_count: (attendance.visit_count ?? 0) + 1,
  });

  return created({ visit: toVisit(visit), client: { id: client.id, name: client.display_name } }, { ctx });
}, { permission: 'attendance.self' });

router.post('/visits/:id/complete', async (ctx) => {
  const scope = scopeFor(ctx);
  const visit = await scope.getOrFail('gps_visits', ctx.params.id, { resource: 'Visit' });
  if (visit.user_id !== ctx.userId && !ctx.has('attendance.manage')) {
    throw new ForbiddenError('That is not your visit.');
  }
  if (visit.checked_out_at) throw new ConflictError('That visit is already closed.');

  const body = await ctx.body();
  const input = validate(body, {
    notes: { type: 'text', max: 1000 },
    documentsCollected: { type: 'int', min: 0, max: 500 },
  });

  const minutes = Math.max(0, Math.round(secondsBetween(visit.checked_in_at, nowIso()) / 60));
  await scope.update('gps_visits', visit.id, {
    checked_out_at: nowIso(),
    duration_minutes: minutes,
    notes: input.notes ?? visit.notes,
    documents_collected: input.documentsCollected ?? visit.documents_collected,
  });

  return ok({ visit: toVisit(await scope.first('gps_visits', { id: visit.id })), durationMinutes: minutes }, { ctx });
}, { permission: 'attendance.self' });

// ---------------------------------------------------------------------------
// Team attendance
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('attendance', 'a');
  // Without attendance.view, you see your own record and nobody else's.
  if (!ctx.has('attendance.view')) where.add('a.user_id = ?', ctx.userId);
  where.eqIf('a.user_id', ctx.q('userId'));
  where.eqIf('a.branch_id', ctx.q('branchId'));
  where.eqIf('a.status', ctx.q('status'));
  where.betweenIf('a.day', ctx.q('from'), ctx.q('to'));

  const { rows, total } = await scope.paginate('attendance', where, {
    columns: 'a.*, u.full_name AS user_name, b.name AS branch_name',
    joins: 'LEFT JOIN users u ON u.id = a.user_id LEFT JOIN branches b ON b.id = a.branch_id',
    alias: 'a',
    orderBy: `a.${safeOrder(ctx.q('sort', 'day'), ctx.q('dir', 'desc'), ['day', 'worked_minutes'], 'day')}`,
    page, pageSize,
  });

  return paginated(rows.map(toAttendance), { page, pageSize, total }, ctx);
}, { anyPermission: ['attendance.view', 'attendance.self'] });

router.get('/summary', async (ctx) => {
  const scope = scopeFor(ctx);
  const from = ctx.q('from') ?? dayKey(new Date(Date.now() - 30 * 86400000));
  const to = ctx.q('to') ?? dayKey();

  const rows = await scope.raw(
    `SELECT u.id, u.full_name,
            COUNT(a.id) AS days_present,
            COALESCE(SUM(a.worked_minutes), 0) AS worked_minutes,
            COALESCE(SUM(a.visit_count), 0) AS visits,
            COALESCE(SUM(a.travel_km), 0) AS travel_km,
            SUM(CASE WHEN a.check_in_within_geofence = 0 THEN 1 ELSE 0 END) AS outside_geofence
       FROM users u
       LEFT JOIN attendance a ON a.user_id = u.id AND a.day BETWEEN ? AND ?
      WHERE u.tenant_id = ? AND u.status = 'active' AND u.deleted_at IS NULL
      GROUP BY u.id ORDER BY u.full_name`,
    [from, to, ctx.tenantId]);

  return ok({
    period: { from, to },
    staff: rows.map(r => {
      const minutes = Number(r.worked_minutes) || 0;
      const days = Number(r.days_present) || 0;
      return {
        userId: r.id,
        name: r.full_name,
        daysPresent: days,
        workedMinutes: minutes,
        workedLabel: `${Math.floor(minutes / 60)}h ${minutes % 60}m`,
        averageDayMinutes: days ? Math.round(minutes / days) : null,
        visits: Number(r.visits) || 0,
        travelKm: Math.round((Number(r.travel_km) || 0) * 10) / 10,
        // Context, not an accusation: a field executive is meant to be out.
        daysStartedAwayFromBranch: Number(r.outside_geofence) || 0,
      };
    }),
  }, { ctx });
}, { permission: 'attendance.view' });

/** Correct a record — always recorded as a correction, never a silent edit. */
router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const record = await scope.getOrFail('attendance', ctx.params.id, { resource: 'Attendance record' });

  const body = await ctx.body();
  const input = validate(body, {
    status: { type: 'enum', values: ['present', 'absent', 'leave', 'holiday', 'half_day'] },
    checkInAt: { type: 'date' },
    checkOutAt: { type: 'date' },
    notes: { type: 'text', max: 500 },
    reason: { type: 'text', required: true, max: 500, label: 'Reason for the correction' },
  });

  const patch = {};
  if (input.status) patch.status = input.status;
  if (input.checkInAt) patch.check_in_at = input.checkInAt;
  if (input.checkOutAt) patch.check_out_at = input.checkOutAt;
  if (input.notes) patch.notes = input.notes;
  if (Object.keys(patch).length === 0) throw new BadRequestError('Nothing to correct.');

  if (patch.check_in_at || patch.check_out_at) {
    const start = patch.check_in_at ?? record.check_in_at;
    const end = patch.check_out_at ?? record.check_out_at;
    if (start && end) {
      if (end < start) throw new BadRequestError('Check-out cannot be before check-in.');
      patch.worked_minutes = Math.round(secondsBetween(start, end) / 60);
    }
  }

  await scope.update('attendance', record.id, patch);
  await audit(ctx, {
    action: 'settings.updated', category: 'general', severity: 'notice',
    entityType: 'attendance', entityId: record.id,
    entityLabel: `${record.day} attendance`,
    oldValue: {
      status: record.status, check_in_at: record.check_in_at,
      check_out_at: record.check_out_at, worked_minutes: record.worked_minutes,
    },
    newValue: { ...patch, reason: input.reason },
  });

  return ok({ attendance: toAttendance(await scope.first('attendance', { id: record.id })) }, { ctx });
}, { permission: 'attendance.manage' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Is this coordinate inside the branch geofence?
 *
 * Haversine on a spherical earth. Good to a few metres at these distances,
 * which is well inside GPS accuracy on a phone.
 */
function geofenceCheck(branch, latitude, longitude) {
  if (!branch || branch.latitude === null || branch.latitude === undefined) {
    return { within: null, distanceMetres: null, radiusMetres: null, reason: 'No geofence is set for this branch.' };
  }
  const distance = haversineMetres(branch.latitude, branch.longitude, latitude, longitude);
  const radius = branch.geofence_m ?? 200;
  return {
    within: distance <= radius,
    distanceMetres: Math.round(distance),
    radiusMetres: radius,
    reason: null,
  };
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance actually travelled between the recorded points.
 *
 * Straight lines between check-in, each visit and check-out — an underestimate
 * of road distance, and labelled as such wherever it is shown, rather than a
 * figure dressed up as a reimbursable total.
 */
function estimateTravelKm(record, visits, checkout) {
  const points = [[record.check_in_lat, record.check_in_lng]];
  for (const v of visits) points.push([v.latitude, v.longitude]);
  if (checkout?.latitude !== null && checkout?.latitude !== undefined) {
    points.push([checkout.latitude, checkout.longitude]);
  }

  let metres = 0;
  for (let i = 1; i < points.length; i++) {
    const [aLat, aLng] = points[i - 1];
    const [bLat, bLng] = points[i];
    if ([aLat, aLng, bLat, bLng].some(v => v === null || v === undefined)) continue;
    metres += haversineMetres(aLat, aLng, bLat, bLng);
  }
  return Math.round((metres / 1000) * 10) / 10;
}

function toAttendance(a) {
  return {
    id: a.id,
    userId: a.user_id,
    userName: a.user_name ?? null,
    branchId: a.branch_id,
    branchName: a.branch_name ?? null,
    day: a.day,
    checkInAt: a.check_in_at,
    checkOutAt: a.check_out_at,
    checkInAddress: a.check_in_address,
    checkOutAddress: a.check_out_address,
    checkInWithinGeofence: a.check_in_within_geofence === null ? null : !!a.check_in_within_geofence,
    checkOutWithinGeofence: a.check_out_within_geofence === null ? null : !!a.check_out_within_geofence,
    workedMinutes: a.worked_minutes,
    travelKm: a.travel_km,
    travelNote: 'Straight-line distance between recorded points; road distance will be greater.',
    visitCount: a.visit_count,
    status: a.status,
    notes: a.notes,
  };
}

function toVisit(v) {
  return {
    id: v.id,
    clientId: v.client_id,
    purpose: v.purpose,
    checkedInAt: v.checked_in_at,
    checkedOutAt: v.checked_out_at,
    durationMinutes: v.duration_minutes,
    address: v.address,
    accuracyMetres: v.accuracy_m,
    documentsCollected: v.documents_collected,
    notes: v.notes,
  };
}

export { router as fieldOpsRouter };
