/**
 * Team management: the user directory, invitations, roles and per-user
 * permission overrides.
 *
 * Two rules shape this module. A user may never grant a role above their own
 * level, and a user may never edit their own roles or status — otherwise the
 * role hierarchy is decorative. Both are enforced here, server-side.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addDays } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertWithinLimit } from '../services/features.js';
import { dispatchNotification } from '../services/notifications.js';
import { hashPassword, generateTemporaryPassword, checkPasswordPolicy } from '../auth/password.js';
import { ROLE_DEFINITIONS, canManageRole, highestLevel, roleLevel } from '../permissions/roles.js';
import { PERMISSIONS, PERMISSION_MAP, permissionsByCategory } from '../permissions/catalog.js';
import { revokeAllUserSessions } from '../auth/session.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('users', 'u');
  where.add('u.deleted_at IS NULL');
  where.eqIf('u.status', ctx.q('status'));
  where.eqIf('u.branch_id', ctx.q('branchId'));
  where.searchIf(['u.full_name', 'u.email', 'u.phone', 'u.job_title'], ctx.q('q'));

  const roleKey = ctx.q('role');
  if (roleKey) {
    where.add(`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                        WHERE ur.user_id = u.id AND r.key = ?)`, roleKey);
  }

  const { rows, total } = await scope.paginate('users', where, {
    columns: `u.id, u.email, u.full_name, u.phone, u.job_title, u.status, u.branch_id,
              u.twofa_enabled, u.last_login_at, u.created_at, u.avatar_key, u.is_demo,
              b.name AS branch_name,
              (SELECT COUNT(*) FROM user_companies uc WHERE uc.user_id = u.id) AS company_count`,
    joins: 'LEFT JOIN branches b ON b.id = u.branch_id',
    alias: 'u',
    orderBy: `u.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'full_name', 'last_login_at', 'status'], 'created_at')}`,
    page, pageSize,
  });

  const roles = await rolesForUsers(scope, rows.map(r => r.id));
  const counts = await scope.rawOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'invited' THEN 1 ELSE 0 END) AS invited,
            SUM(CASE WHEN status IN ('suspended','locked','deactivated') THEN 1 ELSE 0 END) AS inactive,
            SUM(CASE WHEN twofa_enabled = 1 THEN 1 ELSE 0 END) AS with_2fa
       FROM users WHERE tenant_id = ? AND deleted_at IS NULL`, [ctx.tenantId]);

  return paginated(rows.map(u => shapeUser(u, roles.get(u.id) ?? [])), {
    page, pageSize, total,
    summary: {
      total: Number(counts?.total) || 0,
      active: Number(counts?.active) || 0,
      invited: Number(counts?.invited) || 0,
      inactive: Number(counts?.inactive) || 0,
      withTwoFactor: Number(counts?.with_2fa) || 0,
    },
  }, ctx);
}, { permission: 'users.view' });

/** The roles this user is allowed to hand out — never above their own level. */
router.get('/assignable-roles', async (ctx) => {
  const scope = scopeFor(ctx);
  const custom = await scope.all('roles', { is_system: 0 }, { order: 'name ASC' });
  const myLevel = ctx.isSuperAdmin ? 100 : highestLevel(ctx.roleKeys);

  const system = ROLE_DEFINITIONS.map(r => ({
    key: r.key, name: r.name, description: r.description, level: r.level,
    isSystem: true,
    assignable: ctx.isSuperAdmin || canManageRole(ctx.roleKeys, r.key),
    permissionCount: r.permissions.includes('*') ? PERMISSIONS.length : r.permissions.length,
  }));

  return ok({
    roles: system,
    customRoles: custom.map(r => ({
      key: r.key, name: r.name, description: r.description, level: r.level,
      isSystem: false, assignable: r.level < myLevel,
    })),
    yourLevel: myLevel,
    permissionCatalogue: permissionsByCategory(),
  }, { ctx });
}, { permission: 'users.view' });

router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.first('users', { id: ctx.params.id });
  if (!user || user.deleted_at) throw new NotFoundError('User');

  const roles = (await rolesForUsers(scope, [user.id])).get(user.id) ?? [];
  const companies = await scope.raw(
    `SELECT c.id, c.name, c.gstin, uc.relationship, uc.is_default
       FROM user_companies uc JOIN companies c ON c.id = uc.company_id
      WHERE uc.user_id = ? ORDER BY uc.is_default DESC, c.name`, [user.id]);
  const overrides = await scope.raw(
    'SELECT permission_key, granted, reason, expires_at FROM user_permissions WHERE user_id = ?', [user.id]);
  const recentLogins = await scope.raw(
    `SELECT result, ip, user_agent, anomaly, created_at FROM login_events
      WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, [user.id]);
  const sessions = await scope.raw(
    `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at
       FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC`, [user.id, nowIso()]);

  return ok({
    user: shapeUser(user, roles),
    companies,
    permissionOverrides: overrides.map(o => ({
      key: o.permission_key,
      label: PERMISSION_MAP.get(o.permission_key)?.name ?? o.permission_key,
      granted: !!o.granted, reason: o.reason, expiresAt: o.expires_at,
    })),
    recentLogins,
    activeSessions: sessions,
    canEdit: canEditTarget(ctx, roles),
  }, { ctx });
}, { permission: 'users.view' });

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------
router.post('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    email: { type: 'email', required: true },
    fullName: { type: 'string', required: true, max: 120 },
    phone: { type: 'phone' },
    jobTitle: { type: 'string', max: 80 },
    roleKey: { type: 'string', required: true, max: 40 },
    branchId: { type: 'id' },
    companyIds: { type: 'array', max: 200, of: { type: 'id' } },
    sendInvite: { type: 'boolean', default: true },
  });

  await assertWithinLimit(ctx, 'users', 1);

  const db = new Db(ctx.env.DB);
  const existing = await db.one(
    'SELECT id FROM users WHERE email = ? AND tenant_id = ? AND deleted_at IS NULL',
    [input.email, ctx.tenantId]);
  if (existing) throw new ConflictError('Someone with that email address is already on your team.');

  const role = await resolveRole(ctx, scope, input.roleKey);

  if (input.branchId) await scope.getOrFail('branches', input.branchId, { resource: 'Branch' });

  const temporaryPassword = generateTemporaryPassword();
  const userId = ID.user();
  const ts = nowIso();

  await scope.insert('users', {
    id: userId,
    email: input.email,
    password_hash: await hashPassword(temporaryPassword),
    full_name: input.fullName,
    phone: input.phone ?? null,
    job_title: input.jobTitle ?? null,
    branch_id: input.branchId ?? null,
    status: 'invited',
    must_change_password: 1,
  });

  await new Db(ctx.env.DB).insert('user_roles', {
    user_id: userId, role_id: role.id, assigned_by: ctx.userId, assigned_at: ts,
  });

  const companyIds = input.companyIds ?? [];
  for (const [i, companyId] of companyIds.entries()) {
    const company = await scope.first('companies', { id: companyId });
    if (!company) continue;
    await new Db(ctx.env.DB).insert('user_companies', {
      user_id: userId, company_id: companyId, relationship: 'member',
      is_default: i === 0 ? 1 : 0, created_at: ts,
    });
  }

  await audit(ctx, {
    action: 'users.invited', category: 'users', severity: 'notice',
    entityType: 'user', entityId: userId, entityLabel: input.fullName,
    newValue: { email: input.email, role: role.key, branchId: input.branchId ?? null },
  });

  let invite = { sent: false, reason: 'not_requested' };
  if (input.sendInvite) {
    const result = await dispatchNotification(ctx, {
      triggerKey: 'account.invited',
      userId,
      channels: ['email'],
      link: { path: '/login' },
      variables: {
        name: input.fullName,
        organisation: ctx.tenant?.name ?? 'your organisation',
        email: input.email,
        temporaryPassword,
        loginUrl: `${ctx.env.APP_URL || ''}/login`,
        expiresAt: addDays(7),
      },
    });
    invite = {
      sent: result.summary.sent > 0,
      // When email is not configured the invite says so, rather than leaving
      // an administrator to believe a message went out.
      notConfigured: result.summary.notConfigured > 0,
      summary: result.summary,
    };
  }

  const fresh = await scope.first('users', { id: userId });
  return created({
    user: shapeUser(fresh, [{ key: role.key, name: role.name, level: role.level }]),
    // Returned once, so an admin can pass it on if email is not configured.
    temporaryPassword,
    invite,
  }, { ctx });
}, { permission: 'users.create' });

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.getOrFail('users', ctx.params.id, { resource: 'User' });
  const roles = (await rolesForUsers(scope, [user.id])).get(user.id) ?? [];
  assertCanEdit(ctx, user, roles);

  const body = await ctx.body();
  const input = validate(body, {
    fullName: { type: 'string', max: 120 },
    phone: { type: 'phone' },
    jobTitle: { type: 'string', max: 80 },
    branchId: { type: 'id' },
    status: { type: 'enum', values: ['active', 'suspended', 'deactivated'] },
    locale: { type: 'string', max: 10 },
    timezone: { type: 'string', max: 40 },
  });

  if (input.status && user.id === ctx.userId) {
    throw new ForbiddenError('You cannot change your own account status.');
  }
  if (input.branchId) await scope.getOrFail('branches', input.branchId, { resource: 'Branch' });

  const patch = prune({
    full_name: input.fullName,
    phone: input.phone,
    job_title: input.jobTitle,
    branch_id: input.branchId,
    status: input.status,
    locale: input.locale,
    timezone: input.timezone,
  });
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  await scope.update('users', user.id, patch);

  // Suspending someone has to end their sessions, or the change is cosmetic.
  if (input.status && input.status !== 'active') {
    await revokeAllUserSessions(new Db(ctx.env.DB), user.id, { reason: 'status_changed' });
  }

  await audit(ctx, {
    action: 'users.updated', category: 'users',
    entityType: 'user', entityId: user.id, entityLabel: user.full_name,
    oldValue: pick(user, Object.keys(patch)), newValue: patch,
  });

  const fresh = await scope.first('users', { id: user.id });
  return ok({ user: shapeUser(fresh, roles) }, { ctx });
}, { permission: 'users.update' });

/** Replace a user's roles. */
router.put('/:id/roles', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.getOrFail('users', ctx.params.id, { resource: 'User' });
  const currentRoles = (await rolesForUsers(scope, [user.id])).get(user.id) ?? [];

  if (user.id === ctx.userId) {
    throw new ForbiddenError('You cannot change your own roles. Ask another administrator.');
  }
  assertCanEdit(ctx, user, currentRoles);

  const body = await ctx.body();
  const input = validate(body, {
    roleKeys: { type: 'array', required: true, max: 5, of: { type: 'string', max: 40 } },
  });
  if (!input.roleKeys.length) throw new BadRequestError('A user needs at least one role.');

  const resolved = [];
  for (const key of input.roleKeys) resolved.push(await resolveRole(ctx, scope, key));

  const db = new Db(ctx.env.DB);
  await db.run('DELETE FROM user_roles WHERE user_id = ?', [user.id]);
  const ts = nowIso();
  for (const role of resolved) {
    await db.insert('user_roles', {
      user_id: user.id, role_id: role.id, assigned_by: ctx.userId, assigned_at: ts,
    });
  }

  // A permission change must reach the user immediately, not at next login.
  await revokeAllUserSessions(db, user.id, { reason: 'roles_changed' });

  await audit(ctx, {
    action: 'users.role_changed', category: 'users', severity: 'warning',
    entityType: 'user', entityId: user.id, entityLabel: user.full_name,
    oldValue: { roles: currentRoles.map(r => r.key) },
    newValue: { roles: resolved.map(r => r.key) },
  });

  return ok({
    user: shapeUser(user, resolved.map(r => ({ key: r.key, name: r.name, level: r.level }))),
    sessionsRevoked: true,
  }, { ctx });
}, { permission: 'roles.manage' });

/** Grant or revoke a single permission for one user. */
router.put('/:id/permissions', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.getOrFail('users', ctx.params.id, { resource: 'User' });
  const roles = (await rolesForUsers(scope, [user.id])).get(user.id) ?? [];
  assertCanEdit(ctx, user, roles);

  const body = await ctx.body();
  const input = validate(body, {
    permissionKey: { type: 'string', required: true, max: 60 },
    granted: { type: 'boolean', required: true },
    reason: { type: 'text', max: 500 },
    expiresAt: { type: 'date' },
    remove: { type: 'boolean', default: false },
  });

  if (!PERMISSION_MAP.has(input.permissionKey)) {
    throw new BadRequestError(`Unknown permission: ${input.permissionKey}.`);
  }
  // Granting a permission you do not hold yourself is privilege escalation.
  if (input.granted && !ctx.has(input.permissionKey)) {
    throw new ForbiddenError('You cannot grant a permission you do not hold yourself.');
  }

  const db = new Db(ctx.env.DB);
  await db.run('DELETE FROM user_permissions WHERE user_id = ? AND permission_key = ?',
    [user.id, input.permissionKey]);

  if (!input.remove) {
    await db.insert('user_permissions', {
      user_id: user.id,
      permission_key: input.permissionKey,
      granted: input.granted ? 1 : 0,
      reason: input.reason ?? null,
      expires_at: input.expiresAt ?? null,
      assigned_by: ctx.userId,
      assigned_at: nowIso(),
    });
  }

  await revokeAllUserSessions(db, user.id, { reason: 'permissions_changed' });
  await audit(ctx, {
    action: 'users.role_changed', category: 'users', severity: 'warning',
    entityType: 'user', entityId: user.id, entityLabel: user.full_name,
    newValue: {
      permission: input.permissionKey,
      effect: input.remove ? 'cleared' : (input.granted ? 'granted' : 'revoked'),
      reason: input.reason ?? null,
    },
  });

  const overrides = await scope.raw(
    'SELECT permission_key, granted, reason, expires_at FROM user_permissions WHERE user_id = ?', [user.id]);
  return ok({
    permissionOverrides: overrides.map(o => ({
      key: o.permission_key,
      label: PERMISSION_MAP.get(o.permission_key)?.name ?? o.permission_key,
      granted: !!o.granted, reason: o.reason, expiresAt: o.expires_at,
    })),
  }, { ctx });
}, { permission: 'roles.manage' });

/** Assign the companies a user may work on. */
router.put('/:id/companies', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.getOrFail('users', ctx.params.id, { resource: 'User' });
  const roles = (await rolesForUsers(scope, [user.id])).get(user.id) ?? [];
  assertCanEdit(ctx, user, roles);

  const body = await ctx.body();
  const input = validate(body, {
    companyIds: { type: 'array', required: true, max: 500, of: { type: 'id' } },
    defaultCompanyId: { type: 'id' },
  });

  const db = new Db(ctx.env.DB);
  await db.run('DELETE FROM user_companies WHERE user_id = ?', [user.id]);
  const ts = nowIso();
  let assigned = 0;
  for (const companyId of input.companyIds) {
    const company = await scope.first('companies', { id: companyId });
    if (!company) continue;
    await db.insert('user_companies', {
      user_id: user.id, company_id: companyId, relationship: 'member',
      is_default: companyId === (input.defaultCompanyId ?? input.companyIds[0]) ? 1 : 0,
      created_at: ts,
    });
    assigned += 1;
  }

  await audit(ctx, {
    action: 'users.updated', category: 'users',
    entityType: 'user', entityId: user.id, entityLabel: user.full_name,
    newValue: { companies: assigned },
  });

  return ok({ assigned, requested: input.companyIds.length }, { ctx });
}, { permission: 'users.update' });

/** Reset someone's password and force a change at next login. */
router.post('/:id/reset-password', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.getOrFail('users', ctx.params.id, { resource: 'User' });
  const roles = (await rolesForUsers(scope, [user.id])).get(user.id) ?? [];
  assertCanEdit(ctx, user, roles);

  const body = await ctx.body().catch(() => ({}));
  const input = validate(body ?? {}, { password: { type: 'string', max: 128 } });

  if (input.password) {
    const policy = checkPasswordPolicy(input.password);
    if (!policy.ok) throw new BadRequestError(policy.message);
  }
  const temporaryPassword = input.password ?? generateTemporaryPassword();

  await scope.update('users', user.id, {
    password_hash: await hashPassword(temporaryPassword),
    must_change_password: 1,
    failed_login_count: 0,
    locked_until: null,
    status: user.status === 'locked' ? 'active' : user.status,
  });
  await revokeAllUserSessions(new Db(ctx.env.DB), user.id, { reason: 'password_reset_by_admin' });

  await audit(ctx, {
    action: 'auth.password_reset', category: 'auth', severity: 'warning',
    entityType: 'user', entityId: user.id, entityLabel: user.full_name,
    newValue: { by: ctx.user.full_name, forced: true },
  });

  const notice = await dispatchNotification(ctx, {
    triggerKey: 'account.password_reset', userId: user.id, channels: ['email'],
    link: { path: '/login' },
    variables: { name: user.full_name, loginUrl: `${ctx.env.APP_URL || ''}/login` },
  });

  return ok({
    temporaryPassword, sessionsRevoked: true, notification: notice.summary,
  }, { ctx });
}, { permission: 'users.update', stepUp: true });

/** Deactivate — never a hard delete, because audit history must survive. */
router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.getOrFail('users', ctx.params.id, { resource: 'User' });
  const roles = (await rolesForUsers(scope, [user.id])).get(user.id) ?? [];
  assertCanEdit(ctx, user, roles);

  if (user.id === ctx.userId) throw new ForbiddenError('You cannot deactivate your own account.');

  // The last administrator cannot be removed, or nobody can administer.
  const admins = await scope.rawOne(
    `SELECT COUNT(*) AS n FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.tenant_id = ? AND u.status = 'active' AND u.deleted_at IS NULL
        AND r.key IN ('admin','super_admin')`, [ctx.tenantId]);
  const isAdmin = roles.some(r => r.key === 'admin' || r.key === 'super_admin');
  if (isAdmin && Number(admins?.n) <= 1) {
    throw new ConflictError('This is the only active administrator. Promote someone else first.');
  }

  await scope.update('users', user.id, { status: 'deactivated' });
  await revokeAllUserSessions(new Db(ctx.env.DB), user.id, { reason: 'deactivated' });

  await audit(ctx, {
    action: 'users.deactivated', category: 'users', severity: 'warning',
    entityType: 'user', entityId: user.id, entityLabel: user.full_name,
    oldValue: { status: user.status }, newValue: { status: 'deactivated' },
  });

  return ok({ id: user.id, status: 'deactivated' }, { ctx });
}, { permission: 'users.delete' });

/** End one of a user's sessions from the admin side. */
router.delete('/:id/sessions/:sessionId', async (ctx) => {
  const scope = scopeFor(ctx);
  const user = await scope.getOrFail('users', ctx.params.id, { resource: 'User' });
  const db = new Db(ctx.env.DB);
  const result = await db.run(
    `UPDATE sessions SET revoked_at = ?, revoked_reason = 'admin'
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [nowIso(), ctx.params.sessionId, user.id]);
  if (!result.meta?.changes) throw new NotFoundError('Session');

  await audit(ctx, {
    action: 'auth.session_revoked', category: 'auth', severity: 'notice',
    entityType: 'user', entityId: user.id, entityLabel: user.full_name,
    newValue: { sessionId: ctx.params.sessionId },
  });
  return ok({ revoked: true }, { ctx });
}, { permission: 'users.update' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function rolesForUsers(scope, userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const placeholders = userIds.map(() => '?').join(',');
  const rows = await scope.raw(
    `SELECT ur.user_id, r.key, r.name, r.level FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id IN (${placeholders})`, userIds);
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push({ key: r.key, name: r.name, level: r.level });
  }
  return map;
}

/** Resolve a role key, refusing anything above the caller's own level. */
async function resolveRole(ctx, scope, key) {
  const db = new Db(ctx.env.DB);
  const role = await db.one(
    'SELECT * FROM roles WHERE key = ? AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY tenant_id DESC LIMIT 1',
    [key, ctx.tenantId]);
  if (!role) throw new BadRequestError(`Unknown role: ${key}.`);

  if (!ctx.isSuperAdmin) {
    const myLevel = highestLevel(ctx.roleKeys);
    const targetLevel = role.is_system ? roleLevel(role.key) : role.level;
    if (targetLevel >= myLevel) {
      throw new ForbiddenError(`You cannot assign the ${role.name} role — it sits at or above your own level.`);
    }
  }
  return role;
}

function canEditTarget(ctx, roles) {
  if (ctx.isSuperAdmin) return true;
  const myLevel = highestLevel(ctx.roleKeys);
  const targetLevel = roles.reduce((max, r) => Math.max(max, r.level ?? 0), 0);
  return targetLevel < myLevel;
}

function assertCanEdit(ctx, user, roles) {
  if (user.deleted_at) throw new NotFoundError('User');
  if (user.id === ctx.userId) return; // editing your own profile fields is fine
  if (!canEditTarget(ctx, roles)) {
    throw new ForbiddenError('That user holds a role at or above your own, so you cannot edit their account.');
  }
}

function shapeUser(u, roles) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    phone: u.phone ?? null,
    jobTitle: u.job_title ?? null,
    status: u.status,
    branchId: u.branch_id ?? null,
    branchName: u.branch_name ?? null,
    avatarKey: u.avatar_key ?? null,
    twoFactorEnabled: !!u.twofa_enabled,
    mustChangePassword: !!u.must_change_password,
    lastLoginAt: u.last_login_at ?? null,
    createdAt: u.created_at,
    isDemo: !!u.is_demo,
    companyCount: u.company_count === undefined ? undefined : Number(u.company_count),
    roles,
    primaryRole: roles.length
      ? roles.reduce((best, r) => ((r.level ?? 0) > (best.level ?? 0) ? r : best))
      : null,
  };
}

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}

export { router as usersRouter };
