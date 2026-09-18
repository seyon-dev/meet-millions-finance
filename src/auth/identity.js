/**
 * Identity resolution — turning a session into "who is this, and what may
 * they touch". Runs once per request and produces:
 *   user, tenant, roles, effective permission set, and the company scope
 *   that narrows every subsequent query.
 */

import { permissionsForRoles } from '../permissions/roles.js';
import { AuthRequiredError, ForbiddenError } from '../http/errors.js';
import { nowIso } from '../utils/time.js';

export async function loadIdentity(db, userId) {
  const user = await db.one(
    `SELECT id, tenant_id, email, full_name, phone, avatar_key, job_title, branch_id, status,
            twofa_enabled, twofa_enrolled_at, must_change_password, last_login_at, locale,
            timezone, theme, is_demo, created_at
       FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);
  if (!user) throw new AuthRequiredError('Your account could not be found.');
  if (user.status === 'suspended') throw new ForbiddenError('This account has been suspended.');
  if (user.status === 'deactivated') throw new ForbiddenError('This account has been deactivated.');

  const roles = await db.many(
    `SELECT r.id, r.key, r.name, r.level, r.is_system
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? ORDER BY r.level DESC`, [userId]);

  const roleKeys = roles.map(r => r.key);
  const permissions = permissionsForRoles(roleKeys);

  // Custom (tenant-defined) roles carry their grants in role_permissions.
  const customRoleIds = roles.filter(r => !r.is_system).map(r => r.id);
  if (customRoleIds.length) {
    const rows = await db.many(
      `SELECT permission_key, granted FROM role_permissions
        WHERE role_id IN (${customRoleIds.map(() => '?').join(',')})`, customRoleIds);
    for (const row of rows) {
      if (row.granted) permissions.add(row.permission_key);
    }
  }

  // Per-user overrides are applied last and may revoke as well as grant.
  const overrides = await db.many(
    `SELECT permission_key, granted, expires_at FROM user_permissions
      WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    [userId, nowIso()]);
  for (const o of overrides) {
    // An expired override is simply not loaded, so a temporary elevation ends
    // by itself rather than waiting for someone to remember to remove it.
    if (o.granted) permissions.add(o.permission_key);
    else { permissions.delete(o.permission_key); }
  }

  const tenant = user.tenant_id
    ? await db.one(
        `SELECT id, name, slug, status, gstin, pan, tan, state_code, timezone, currency,
                franchise_id, is_demo, onboarding_step
           FROM tenants WHERE id = ? AND deleted_at IS NULL`, [user.tenant_id])
    : null;

  if (user.tenant_id && !tenant) throw new ForbiddenError('Your organisation is no longer active.');
  if (tenant && tenant.status === 'suspended') {
    throw new ForbiddenError('Your organisation’s account is suspended. Contact support to restore access.');
  }

  const memberships = await db.many(
    `SELECT uc.company_id, uc.relationship, uc.is_default, c.name, c.gstin, c.status
       FROM user_companies uc JOIN companies c ON c.id = uc.company_id
      WHERE uc.user_id = ? AND c.deleted_at IS NULL
      ORDER BY uc.is_default DESC, c.name ASC`, [userId]);

  // No membership rows means "everything in the tenant", which is how staff
  // roles work. Client users always have explicit rows, so they are confined.
  const companyScope = memberships.length ? memberships.map(m => m.company_id) : null;

  return {
    user,
    tenant,
    roles,
    roleKeys,
    permissions,
    memberships,
    companyScope,
    defaultCompanyId: memberships.find(m => m.is_default)?.company_id ?? memberships[0]?.company_id ?? null,
  };
}

/**
 * The client record a client-role user is attached to. Client-facing endpoints
 * resolve this rather than trusting a clientId from the request.
 */
export async function loadClientForUser(db, userId, tenantId) {
  return db.one(
    `SELECT c.* FROM clients c
       JOIN client_contacts cc ON cc.client_id = c.id
      WHERE cc.user_id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
      ORDER BY cc.is_primary DESC LIMIT 1`, [userId, tenantId]);
}

/** Every client record a client user may see (multi-company clients). */
export async function loadClientIdsForUser(db, userId, tenantId) {
  const rows = await db.many(
    `SELECT DISTINCT c.id FROM clients c
       JOIN client_contacts cc ON cc.client_id = c.id
      WHERE cc.user_id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL`, [userId, tenantId]);
  return rows.map(r => r.id);
}
