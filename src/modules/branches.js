/**
 * Multi-branch management (add-on 22).
 *
 * A branch is an office: it has an address, a manager, staff, companies and,
 * for GPS attendance, a geofence. Branch performance is computed from the work
 * actually recorded against it, never stored as a denormalised figure that can
 * drift away from the truth.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';
import { safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { addDays, nowIso } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertFeature } from '../services/features.js';
import { STATE_CODES, stateName } from '../data/tax-rules.js';

const router = createRouter();

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('branches', 'b');
  where.eqIf('b.status', ctx.q('status'));
  where.searchIf(['b.name', 'b.code', 'b.city'], ctx.q('q'));

  const { rows, total } = await scope.paginate('branches', where, {
    columns: `b.*, u.full_name AS manager_name, u.email AS manager_email,
              (SELECT COUNT(*) FROM users s WHERE s.branch_id = b.id AND s.deleted_at IS NULL) AS staff_count,
              (SELECT COUNT(*) FROM companies c WHERE c.branch_id = b.id AND c.deleted_at IS NULL) AS company_count`,
    joins: 'LEFT JOIN users u ON u.id = b.manager_user_id',
    alias: 'b',
    orderBy: `b.${safeOrder(ctx.q('sort', 'name'), ctx.q('dir', 'asc'), ['name', 'created_at', 'code'], 'name')}`,
    page, pageSize,
  });

  return paginated(rows.map(toBranch), { page, pageSize, total }, ctx);
}, { permission: 'branches.view' });

/** Branch performance — the comparison view the add-on describes. */
router.get('/performance', async (ctx) => {
  const scope = scopeFor(ctx);
  const from = ctx.q('from') ?? addDays(-30);
  const to = ctx.q('to') ?? nowIso();

  const rows = await scope.raw(
    `SELECT b.id, b.name, b.code, b.city,
            (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id AND u.deleted_at IS NULL AND u.status = 'active') AS staff,
            (SELECT COUNT(*) FROM companies c WHERE c.branch_id = b.id AND c.deleted_at IS NULL) AS companies,
            (SELECT COUNT(*) FROM clients cl
               JOIN companies c2 ON c2.id = cl.company_id
              WHERE c2.branch_id = b.id AND cl.deleted_at IS NULL) AS clients,
            (SELECT COUNT(*) FROM documents d
               JOIN companies c3 ON c3.id = d.company_id
              WHERE c3.branch_id = b.id AND d.deleted_at IS NULL
                AND d.created_at BETWEEN ? AND ?) AS documents,
            (SELECT COUNT(*) FROM documents d2
               JOIN companies c4 ON c4.id = d2.company_id
              WHERE c4.branch_id = b.id AND d2.deleted_at IS NULL
                AND d2.status = 'verified' AND d2.verified_at BETWEEN ? AND ?) AS verified,
            (SELECT COALESCE(SUM(i.total_paise), 0) FROM invoices i
               JOIN companies c5 ON c5.id = i.company_id
              WHERE c5.branch_id = b.id AND i.status = 'paid'
                AND i.issue_date BETWEEN ? AND ?) AS revenue_paise
       FROM branches b
      WHERE b.tenant_id = ? AND b.status = 'active'
      ORDER BY b.name`,
    [from, to, from, to, from, to, ctx.tenantId]);

  const branches = rows.map(r => {
    const documents = Number(r.documents) || 0;
    const verified = Number(r.verified) || 0;
    return {
      id: r.id, name: r.name, code: r.code, city: r.city,
      staff: Number(r.staff) || 0,
      companies: Number(r.companies) || 0,
      clients: Number(r.clients) || 0,
      documents,
      verified,
      verificationRatePct: documents ? Math.round((verified / documents) * 100) : null,
      documentsPerStaff: Number(r.staff) ? Math.round((documents / Number(r.staff)) * 10) / 10 : null,
      revenuePaise: Number(r.revenue_paise) || 0,
    };
  });

  return ok({
    period: { from, to },
    branches,
    totals: {
      branches: branches.length,
      staff: branches.reduce((n, b) => n + b.staff, 0),
      clients: branches.reduce((n, b) => n + b.clients, 0),
      documents: branches.reduce((n, b) => n + b.documents, 0),
      revenuePaise: branches.reduce((n, b) => n + b.revenuePaise, 0),
    },
  }, { ctx });
}, { permission: 'branches.view' });

router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const branch = await scope.getOrFail('branches', ctx.params.id, { resource: 'Branch' });

  const staff = await scope.all('users', { branch_id: branch.id },
    { columns: 'id, full_name, email, job_title, status', order: 'full_name ASC', limit: 200 });
  const companies = await scope.all('companies', { branch_id: branch.id },
    { columns: 'id, name, gstin, status', order: 'name ASC', limit: 200 });

  return ok({ branch: toBranch(branch), staff, companies }, { ctx });
}, { permission: 'branches.view' });

router.post('/', async (ctx) => {
  await assertFeature(ctx, 'multi_branch');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    code: { type: 'string', required: true, max: 20 },
    isHeadOffice: { type: 'boolean', default: false },
    addressLine1: { type: 'string', max: 200 },
    city: { type: 'string', max: 80 },
    state: { type: 'string', max: 80 },
    stateCode: { type: 'string', max: 2 },
    pincode: { type: 'string', max: 10 },
    phone: { type: 'phone' },
    email: { type: 'email' },
    managerUserId: { type: 'id' },
    latitude: { type: 'number', min: -90, max: 90 },
    longitude: { type: 'number', min: -180, max: 180 },
    geofenceMetres: { type: 'int', min: 25, max: 5000, default: 200 },
  });

  const code = input.code.toUpperCase();
  const clash = await scope.first('branches', { code });
  if (clash) throw new ConflictError(`Branch code ${code} is already in use by ${clash.name}.`);

  if (input.managerUserId) await scope.getOrFail('users', input.managerUserId, { resource: 'Manager' });

  // A geofence needs both halves of the coordinate to mean anything. An
  // omitted optional field arrives as null, so test for a value, not for
  // undefined.
  if ((input.latitude === null) !== (input.longitude === null)) {
    throw new BadRequestError('A geofence needs both a latitude and a longitude.');
  }

  if (input.isHeadOffice) {
    await scope.updateWhere('branches', { is_head_office: 1 }, { is_head_office: 0 });
  }

  const branch = await scope.insert('branches', {
    id: ID.branch(),
    name: input.name,
    code,
    is_head_office: input.isHeadOffice ? 1 : 0,
    address_line1: input.addressLine1 ?? null,
    city: input.city ?? null,
    state: input.state ?? stateName(input.stateCode ?? '') ?? null,
    state_code: input.stateCode ?? null,
    pincode: input.pincode ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    manager_user_id: input.managerUserId ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    geofence_m: input.geofenceMetres,
    status: 'active',
  });

  await audit(ctx, {
    action: 'branches.created', category: 'branches',
    entityType: 'branch', entityId: branch.id, entityLabel: branch.name,
    newValue: { code, city: input.city ?? null },
  });

  return created({ branch: toBranch(branch) }, { ctx });
}, { permission: 'branches.manage' });

router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const branch = await scope.getOrFail('branches', ctx.params.id, { resource: 'Branch' });
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', max: 120 },
    isHeadOffice: { type: 'boolean' },
    addressLine1: { type: 'string', max: 200 },
    city: { type: 'string', max: 80 },
    state: { type: 'string', max: 80 },
    stateCode: { type: 'string', max: 2 },
    pincode: { type: 'string', max: 10 },
    phone: { type: 'phone' },
    email: { type: 'email' },
    managerUserId: { type: 'id' },
    latitude: { type: 'number', min: -90, max: 90 },
    longitude: { type: 'number', min: -180, max: 180 },
    geofenceMetres: { type: 'int', min: 25, max: 5000 },
    status: { type: 'enum', values: ['active', 'inactive'] },
  });

  if (input.isHeadOffice) {
    await scope.updateWhere('branches', { is_head_office: 1 }, { is_head_office: 0 });
  }

  const patch = prune({
    name: input.name,
    is_head_office: input.isHeadOffice === undefined ? undefined : (input.isHeadOffice ? 1 : 0),
    address_line1: input.addressLine1,
    city: input.city,
    state: input.state,
    state_code: input.stateCode,
    pincode: input.pincode,
    phone: input.phone,
    email: input.email,
    manager_user_id: input.managerUserId,
    latitude: input.latitude,
    longitude: input.longitude,
    geofence_m: input.geofenceMetres,
    status: input.status,
  });
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  await scope.update('branches', branch.id, patch);
  await audit(ctx, {
    action: 'branches.updated', category: 'branches',
    entityType: 'branch', entityId: branch.id, entityLabel: branch.name,
    newValue: patch,
  });

  const fresh = await scope.first('branches', { id: branch.id });
  return ok({ branch: toBranch(fresh) }, { ctx });
}, { permission: 'branches.manage' });

router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const branch = await scope.getOrFail('branches', ctx.params.id, { resource: 'Branch' });

  const staff = await scope.count('users', { branch_id: branch.id });
  const companies = await scope.count('companies', { branch_id: branch.id });
  if (staff || companies) {
    throw new ConflictError(
      `${branch.name} still has ${staff} staff member${staff === 1 ? '' : 's'} and ${companies} compan${companies === 1 ? 'y' : 'ies'} attached. Reassign them first.`);
  }

  await scope.update('branches', branch.id, { status: 'inactive' });
  await audit(ctx, {
    action: 'branches.updated', category: 'branches', severity: 'warning',
    entityType: 'branch', entityId: branch.id, entityLabel: branch.name,
    newValue: { status: 'inactive' },
  });
  return ok({ id: branch.id, status: 'inactive' }, { ctx });
}, { permission: 'branches.manage' });

function toBranch(b) {
  return {
    id: b.id,
    name: b.name,
    code: b.code,
    isHeadOffice: !!b.is_head_office,
    address: {
      line1: b.address_line1 ?? null,
      city: b.city ?? null,
      state: b.state ?? null,
      stateCode: b.state_code ?? null,
      pincode: b.pincode ?? null,
    },
    phone: b.phone ?? null,
    email: b.email ?? null,
    managerUserId: b.manager_user_id ?? null,
    managerName: b.manager_name ?? null,
    managerEmail: b.manager_email ?? null,
    geofence: b.latitude !== null && b.latitude !== undefined
      ? { latitude: b.latitude, longitude: b.longitude, radiusMetres: b.geofence_m }
      : null,
    status: b.status,
    staffCount: b.staff_count === undefined ? undefined : Number(b.staff_count),
    companyCount: b.company_count === undefined ? undefined : Number(b.company_count),
    createdAt: b.created_at,
  };
}

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

export { router as branchesRouter };
