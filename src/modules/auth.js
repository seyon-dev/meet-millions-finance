/**
 * Authentication: registration, sign-in, two-factor, password lifecycle,
 * session management and the bootstrap payload the SPA loads on start.
 */

import { createRouter } from '../http/router.js';
import { ok, created } from '../http/response.js';
import {
  AuthRequiredError, BadRequestError, ConflictError, ForbiddenError,
  NotFoundError, ValidationError, TwoFactorRequiredError,
} from '../http/errors.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addMinutes, addDays, isPast } from '../utils/time.js';
import { hashPassword, verifyPassword, needsRehash, checkPasswordPolicy, PBKDF2_ITERATIONS } from '../auth/password.js';
import {
  generateTotpSecret, verifyTotp, totpUri, generateBackupCodes, consumeBackupCode,
} from '../auth/totp.js';
import {
  createSession, revokeSession, revokeAllUserSessions, listUserSessions,
  markTwoFactorSatisfied, setActiveCompany, DEFAULT_SESSION_HOURS,
} from '../auth/session.js';
import { encryptString, decryptString, sha256Hex, randomToken } from '../auth/crypto.js';
import { loadIdentity } from '../auth/identity.js';
import { ROLE_MAP, landingPathFor, permissionsForRoles } from '../permissions/roles.js';
import { PERMISSIONS } from '../permissions/catalog.js';
import {
  getSecurityPolicy, upsertDevice, recordLoginEvent, registerFailedLogin,
  clearFailedLogins, isLockedOut, detectAnomaly,
} from '../services/security.js';
import { audit, auditAsync } from '../services/audit.js';
import { entitlementsPayload } from '../services/features.js';
import { consumeAttempt } from '../services/ratelimit.js';
import { dispatchNotification } from '../services/notifications.js';
import { navigationFor } from '../services/navigation.js';
import { provisionTenant } from '../services/provisioning.js';

const router = createRouter();
const PUBLIC = { auth: false };

// ---------------------------------------------------------------------------
// Registration — creates the organisation, its first Admin, and a Basic plan.
// ---------------------------------------------------------------------------
router.post('/register', async (ctx) => {
  // The route's `rateLimit` option already meters this IP; nothing further
  // to consume here.
  const body = await ctx.body();

  const input = validate(body, {
    organisationName: { type: 'string', required: true, min: 2, max: 160 },
    fullName: { type: 'string', required: true, min: 2, max: 120 },
    email: { type: 'email', required: true },
    phone: { type: 'phone' },
    password: { type: 'string', required: true, min: 8, max: 256 },
    companyName: { type: 'string', max: 160 },
    gstin: { type: 'gstin', label: 'GSTIN' },
    pan: { type: 'pan', label: 'PAN' },
    tan: { type: 'tan', label: 'TAN' },
    stateCode: { type: 'string', max: 2, default: '33' },
    accountType: { type: 'enum', values: ['firm', 'client'], default: 'firm' },
  });

  const policy = { minLength: 10, requireMixed: true, identity: [input.email, input.fullName] };
  const check = checkPasswordPolicy(input.password, policy);
  if (!check.ok) throw new ValidationError('Choose a stronger password.', { password: check.errors.join(' ') });

  const db = new Db(ctx.env.DB);
  const existing = await db.one('SELECT id FROM users WHERE email = ? LIMIT 1', [input.email]);
  if (existing) {
    throw new ConflictError('An account already exists for that email address. Try signing in instead.');
  }

  const result = await provisionTenant(ctx, {
    organisationName: input.organisationName,
    ownerName: input.fullName,
    ownerEmail: input.email,
    ownerPhone: input.phone,
    passwordHash: await hashPassword(input.password),
    companyName: input.companyName || input.organisationName,
    gstin: input.gstin,
    pan: input.pan,
    tan: input.tan,
    stateCode: input.stateCode,
    accountType: input.accountType,
  });

  const { token, session } = await createSession(ctx.env, db, {
    userId: result.user.id,
    tenantId: result.tenant.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    activeCompanyId: result.company.id,
    twofaSatisfied: true,          // 2FA is not yet enrolled at this point
  });

  await audit(ctx, {
    action: 'auth.register', category: 'auth',
    entityType: 'tenant', entityId: result.tenant.id, entityLabel: result.tenant.name,
    tenantId: result.tenant.id, actorId: result.user.id, actorName: result.user.full_name,
    actorRole: result.roleKey,
    newValue: { organisation: result.tenant.name, plan: 'basic' },
  });

  ctx.defer(dispatchNotification(ctx, {
    triggerKey: 'account.registered',
    tenantId: result.tenant.id,
    userId: result.user.id,
    variables: { name: result.user.full_name, organisation: result.tenant.name },
  }));

  return created({
    token,
    expiresAt: session.expires_at,
    landing: landingPathFor([result.roleKey]),
    nextStep: 'enable_2fa',
    user: publicUser(result.user, [ROLE_MAP.get(result.roleKey)]),
  }, { ctx });
}, { ...PUBLIC, rateLimit: 'auth.register' });

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
router.post('/login', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    email: { type: 'email', required: true },
    password: { type: 'string', required: true, max: 256 },
    rememberMe: { type: 'boolean', default: false },
  });

  // The route option meters by IP; this adds the per-account dimension so a
  // distributed attempt against one mailbox is throttled too.
  await consumeAttempt(ctx, 'auth.login', `email:${input.email}`);

  const db = new Db(ctx.env.DB);
  const user = await db.one(
    'SELECT * FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [input.email]);

  // The same message for "no such user" and "wrong password" — an attacker
  // learns nothing about which addresses exist.
  const invalid = new AuthRequiredError('That email address and password do not match.', 'invalid_credentials');

  if (!user) {
    await recordLoginEvent(db, { email: input.email, result: 'unknown_user', ip: ctx.ip, userAgent: ctx.userAgent });
    throw invalid;
  }

  const policy = await getSecurityPolicy(db, user.tenant_id);

  if (isLockedOut(user)) {
    await recordLoginEvent(db, {
      tenantId: user.tenant_id, userId: user.id, email: user.email,
      result: 'locked', ip: ctx.ip, userAgent: ctx.userAgent,
    });
    throw new ForbiddenError(
      `Too many failed attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString('en-IN')}.`);
  }

  if (user.status === 'suspended' || user.status === 'deactivated') {
    await recordLoginEvent(db, {
      tenantId: user.tenant_id, userId: user.id, email: user.email,
      result: 'suspended', ip: ctx.ip, userAgent: ctx.userAgent,
    });
    throw new ForbiddenError('This account is no longer active. Contact your administrator.');
  }

  const passwordOk = await verifyPassword(input.password, user.password_hash);
  if (!passwordOk) {
    const { locked } = await registerFailedLogin(db, user, policy);
    await recordLoginEvent(db, {
      tenantId: user.tenant_id, userId: user.id, email: user.email,
      result: 'bad_password', ip: ctx.ip, userAgent: ctx.userAgent,
    });
    if (locked) {
      throw new ForbiddenError('Too many failed attempts. This account is locked for a short period.');
    }
    throw invalid;
  }

  // Opportunistically upgrade an old hash now that we hold the plaintext.
  if (needsRehash(user.password_hash, PBKDF2_ITERATIONS)) {
    ctx.defer(hashPassword(input.password).then(h =>
      db.update('users', { id: user.id }, { password_hash: h })));
  }

  const { device, isNew: isNewDevice, blocked } = await upsertDevice(db, {
    userId: user.id, tenantId: user.tenant_id, userAgent: ctx.userAgent, ip: ctx.ip,
  });
  if (blocked) {
    await recordLoginEvent(db, {
      tenantId: user.tenant_id, userId: user.id, email: user.email,
      result: 'device_blocked', ip: ctx.ip, userAgent: ctx.userAgent, deviceId: device.id,
    });
    throw new ForbiddenError('This device has been blocked by your administrator.');
  }

  const anomaly = await detectAnomaly(db, user, { isNewDevice, ip: ctx.ip });
  const identity = await loadIdentity(db, user.id);

  // 2FA: enrolled, or required by policy for this user's roles.
  const roleKeys = identity.roleKeys;
  const policyRoles = safeJson(policy.enforce_2fa_roles, null);
  const policyRequires = !!policy.enforce_2fa &&
    (!policyRoles || roleKeys.some(r => policyRoles.includes(r)));

  if (user.twofa_enabled) {
    const challenge = {
      id: ID.challenge(),
      user_id: user.id,
      kind: 'totp',
      code_hash: null,
      attempts: 0,
      ip: ctx.ip,
      user_agent: (ctx.userAgent || '').slice(0, 400),
      device_id: device.id,
      consumed_at: null,
      created_at: nowIso(),
      expires_at: addMinutes(10),
    };
    await db.insert('auth_challenges', challenge);
    await recordLoginEvent(db, {
      tenantId: user.tenant_id, userId: user.id, email: user.email,
      result: 'twofa_required', ip: ctx.ip, userAgent: ctx.userAgent,
      deviceId: device.id, anomaly,
    });
    return ok({
      status: 'twofa_required',
      challengeId: challenge.id,
      method: 'totp',
      expiresAt: challenge.expires_at,
      anomaly,
    }, { ctx });
  }

  const ttlHours = input.rememberMe
    ? Math.max(policy.session_ttl_hours, 24 * 7)
    : (policy.session_ttl_hours || DEFAULT_SESSION_HOURS);

  const { token, session } = await createSession(ctx.env, db, {
    userId: user.id,
    tenantId: user.tenant_id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    deviceId: device.id,
    activeCompanyId: identity.defaultCompanyId,
    twofaSatisfied: true,
    ttlHours,
  });

  await clearFailedLogins(db, user.id, ctx.ip);
  await recordLoginEvent(db, {
    tenantId: user.tenant_id, userId: user.id, email: user.email,
    result: 'success', ip: ctx.ip, userAgent: ctx.userAgent, deviceId: device.id, anomaly,
  });

  ctx.tenantId = user.tenant_id;
  ctx.user = user;
  await audit(ctx, {
    action: 'auth.login', category: 'auth', entityType: 'user', entityId: user.id,
    entityLabel: user.email, tenantId: user.tenant_id, actorId: user.id,
    actorName: user.full_name, actorRole: roleKeys[0],
    metadata: { anomaly, device: device.label, newDevice: isNewDevice },
  });

  if (anomaly && policy.anomaly_alerts) {
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'security.login_anomaly',
      tenantId: user.tenant_id, userId: user.id,
      variables: { device: device.label, ip: ctx.ip, anomaly, time: nowIso() },
    }));
  }

  return ok({
    status: 'authenticated',
    token,
    expiresAt: session.expires_at,
    landing: landingPathFor(roleKeys),
    mustChangePassword: !!user.must_change_password,
    twoFactorEnrolled: !!user.twofa_enabled,
    twoFactorRequired: policyRequires && !user.twofa_enabled,
    user: publicUser(user, identity.roles),
  }, { ctx });
}, { ...PUBLIC, rateLimit: 'auth.login' });

// ---------------------------------------------------------------------------
// Two-factor verification
// ---------------------------------------------------------------------------
router.post('/2fa/verify', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    challengeId: { type: 'id', required: true },
    code: { type: 'string', required: true, max: 20 },
    rememberMe: { type: 'boolean', default: false },
  });
  await consumeAttempt(ctx, 'auth.twofa', `chal:${input.challengeId}`);

  const db = new Db(ctx.env.DB);
  const challenge = await db.findOne('auth_challenges', { id: input.challengeId });
  if (!challenge || challenge.consumed_at || isPast(challenge.expires_at)) {
    throw new AuthRequiredError('That verification request has expired. Sign in again.', 'challenge_expired');
  }
  if (challenge.attempts >= 5) {
    throw new ForbiddenError('Too many incorrect codes. Sign in again to get a new request.');
  }

  const user = await db.findOne('users', { id: challenge.user_id });
  if (!user) throw new AuthRequiredError('That account is no longer available.');

  const secret = await decryptString(user.twofa_secret, ctx.env.ENCRYPTION_KEY || ctx.env.AUTH_SECRET);
  if (!secret) throw new AuthRequiredError('Two-factor is not set up correctly for this account.', 'twofa_misconfigured');

  let verified = await verifyTotp(secret, input.code) !== null;
  let usedBackupCode = false;

  if (!verified && user.twofa_backup_codes) {
    const remaining = await consumeBackupCode(input.code, safeJson(user.twofa_backup_codes, []));
    if (remaining) {
      verified = true;
      usedBackupCode = true;
      await db.update('users', { id: user.id }, { twofa_backup_codes: JSON.stringify(remaining) });
    }
  }

  if (!verified) {
    await db.update('auth_challenges', { id: challenge.id }, { attempts: challenge.attempts + 1 });
    await recordLoginEvent(db, {
      tenantId: user.tenant_id, userId: user.id, email: user.email,
      result: 'twofa_failed', ip: ctx.ip, userAgent: ctx.userAgent, deviceId: challenge.device_id,
    });
    throw new AuthRequiredError('That code is not correct. Check your authenticator app and try again.', 'invalid_code');
  }

  await db.update('auth_challenges', { id: challenge.id }, { consumed_at: nowIso() });

  const policy = await getSecurityPolicy(db, user.tenant_id);
  const identity = await loadIdentity(db, user.id);
  const ttlHours = input.rememberMe
    ? Math.max(policy.session_ttl_hours, 24 * 7)
    : (policy.session_ttl_hours || DEFAULT_SESSION_HOURS);

  const { token, session } = await createSession(ctx.env, db, {
    userId: user.id, tenantId: user.tenant_id, ip: ctx.ip, userAgent: ctx.userAgent,
    deviceId: challenge.device_id, activeCompanyId: identity.defaultCompanyId,
    twofaSatisfied: true, ttlHours,
  });

  await clearFailedLogins(db, user.id, ctx.ip);
  await recordLoginEvent(db, {
    tenantId: user.tenant_id, userId: user.id, email: user.email,
    result: 'success', ip: ctx.ip, userAgent: ctx.userAgent, deviceId: challenge.device_id,
  });

  ctx.tenantId = user.tenant_id;
  ctx.user = user;
  await audit(ctx, {
    action: 'auth.login', category: 'auth', entityType: 'user', entityId: user.id,
    entityLabel: user.email, tenantId: user.tenant_id, actorId: user.id,
    actorName: user.full_name, actorRole: identity.roleKeys[0],
    metadata: { method: usedBackupCode ? 'backup_code' : 'totp' },
  });

  return ok({
    status: 'authenticated',
    token,
    expiresAt: session.expires_at,
    landing: landingPathFor(identity.roleKeys),
    usedBackupCode,
    backupCodesRemaining: safeJson(user.twofa_backup_codes, []).length - (usedBackupCode ? 1 : 0),
    user: publicUser(user, identity.roles),
  }, { ctx });
}, { ...PUBLIC, rateLimit: 'auth.twofa' });

// ---------------------------------------------------------------------------
// Two-factor enrolment
// ---------------------------------------------------------------------------
router.post('/2fa/setup', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const secret = generateTotpSecret();
  const encrypted = await encryptString(secret, ctx.env.ENCRYPTION_KEY || ctx.env.AUTH_SECRET);

  // Stored but not enabled — enrolment only completes once a code verifies.
  await db.update('users', { id: ctx.userId }, { twofa_secret: encrypted, updated_at: nowIso() });

  return ok({
    secret,
    uri: totpUri(secret, { account: ctx.user.email, issuer: brandName(ctx) }),
    issuer: brandName(ctx),
    account: ctx.user.email,
    digits: 6,
    period: 30,
  }, { ctx });
}, { allowPending2fa: true, allowPasswordChange: true });

router.post('/2fa/enable', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, { code: { type: 'string', required: true, max: 10 } });

  const db = new Db(ctx.env.DB);
  const user = await db.findOne('users', { id: ctx.userId });
  const secret = await decryptString(user.twofa_secret, ctx.env.ENCRYPTION_KEY || ctx.env.AUTH_SECRET);
  if (!secret) throw new BadRequestError('Start the setup again — no pending two-factor secret was found.');

  if (await verifyTotp(secret, input.code) === null) {
    throw new ValidationError('That code is not correct.', { code: 'Check the 6-digit code in your authenticator app.' });
  }

  const backup = await generateBackupCodes(10);
  await db.update('users', { id: ctx.userId }, {
    twofa_enabled: 1,
    twofa_enrolled_at: nowIso(),
    twofa_backup_codes: JSON.stringify(backup.hashed),
    updated_at: nowIso(),
  });
  if (ctx.session) await markTwoFactorSatisfied(db, ctx.session.id);

  auditAsync(ctx, {
    action: 'auth.2fa_enabled', category: 'auth',
    entityType: 'user', entityId: ctx.userId, entityLabel: ctx.user.email, severity: 'notice',
  });

  return ok({
    enabled: true,
    backupCodes: backup.plain,
    message: 'Two-factor authentication is on. Save these recovery codes somewhere safe — each one works once.',
  }, { ctx });
}, { allowPending2fa: true, allowPasswordChange: true });

router.post('/2fa/disable', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, { password: { type: 'string', required: true, max: 256 } });

  const db = new Db(ctx.env.DB);
  const user = await db.findOne('users', { id: ctx.userId });
  if (!(await verifyPassword(input.password, user.password_hash))) {
    throw new ValidationError('Password is not correct.', { password: 'Enter your current password to confirm.' });
  }

  const policy = await getSecurityPolicy(db, ctx.tenantId);
  const policyRoles = safeJson(policy.enforce_2fa_roles, null);
  const required = !!policy.enforce_2fa && (!policyRoles || ctx.roleKeys.some(r => policyRoles.includes(r)));
  if (required) {
    throw new ForbiddenError('Your organisation requires two-factor authentication for your role.');
  }

  await db.update('users', { id: ctx.userId }, {
    twofa_enabled: 0, twofa_secret: null, twofa_backup_codes: null,
    twofa_enrolled_at: null, updated_at: nowIso(),
  });

  auditAsync(ctx, {
    action: 'auth.2fa_disabled', category: 'auth', severity: 'warning',
    entityType: 'user', entityId: ctx.userId, entityLabel: ctx.user.email,
  });

  return ok({ enabled: false }, { ctx });
});

router.post('/2fa/backup-codes', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, { password: { type: 'string', required: true, max: 256 } });

  const db = new Db(ctx.env.DB);
  const user = await db.findOne('users', { id: ctx.userId });
  if (!user.twofa_enabled) throw new BadRequestError('Two-factor authentication is not enabled.');
  if (!(await verifyPassword(input.password, user.password_hash))) {
    throw new ValidationError('Password is not correct.', { password: 'Enter your current password to confirm.' });
  }

  const backup = await generateBackupCodes(10);
  await db.update('users', { id: ctx.userId }, { twofa_backup_codes: JSON.stringify(backup.hashed) });

  auditAsync(ctx, { action: 'auth.2fa_enabled', category: 'auth', severity: 'notice',
    entityType: 'user', entityId: ctx.userId, metadata: { regeneratedBackupCodes: true } });

  return ok({ backupCodes: backup.plain }, { ctx });
});

// ---------------------------------------------------------------------------
// Password lifecycle
// ---------------------------------------------------------------------------
router.post('/forgot-password', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, { email: { type: 'email', required: true } });
  await consumeAttempt(ctx, 'auth.forgot', `email:${input.email}`);

  const db = new Db(ctx.env.DB);
  const user = await db.one(
    'SELECT * FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [input.email]);

  // Always the same answer, whether or not the address exists.
  const response = ok({
    sent: true,
    message: 'If that email address has an account, a reset link is on its way.',
  }, { ctx });

  if (!user || user.status === 'deactivated') return response;

  const token = randomToken(32);
  await db.insert('password_resets', {
    id: ID.reset(),
    user_id: user.id,
    token_hash: await sha256Hex(token),
    ip: ctx.ip,
    used_at: null,
    created_at: nowIso(),
    expires_at: addMinutes(60),
  });

  ctx.tenantId = user.tenant_id;
  ctx.defer(dispatchNotification(ctx, {
    triggerKey: 'account.password_reset',
    tenantId: user.tenant_id,
    userId: user.id,
    variables: {
      name: user.full_name,
      resetUrl: `${ctx.env.APP_URL || ''}/reset-password?token=${encodeURIComponent(token)}`,
      expiresIn: '60 minutes',
    },
  }));

  return response;
}, { ...PUBLIC, rateLimit: 'auth.forgot' });

router.post('/reset-password', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    token: { type: 'string', required: true, max: 200 },
    password: { type: 'string', required: true, max: 256 },
  });

  const db = new Db(ctx.env.DB);
  const record = await db.findOne('password_resets', { token_hash: await sha256Hex(input.token) });
  if (!record || record.used_at || isPast(record.expires_at)) {
    throw new BadRequestError('That reset link has expired. Request a new one.');
  }

  const user = await db.findOne('users', { id: record.user_id });
  if (!user) throw new NotFoundError('Account');

  const policy = await getSecurityPolicy(db, user.tenant_id);
  const check = checkPasswordPolicy(input.password, {
    minLength: policy.password_min_length,
    requireMixed: !!policy.password_require_mixed,
    identity: [user.email, user.full_name],
  });
  if (!check.ok) throw new ValidationError('Choose a stronger password.', { password: check.errors.join(' ') });

  await db.update('users', { id: user.id }, {
    password_hash: await hashPassword(input.password),
    must_change_password: 0,
    failed_login_count: 0,
    locked_until: null,
    updated_at: nowIso(),
  });
  await db.update('password_resets', { id: record.id }, { used_at: nowIso() });
  const revoked = await revokeAllUserSessions(db, user.id, { reason: 'password_reset' });

  ctx.tenantId = user.tenant_id;
  await audit(ctx, {
    action: 'auth.password_reset', category: 'auth', severity: 'notice',
    entityType: 'user', entityId: user.id, entityLabel: user.email,
    tenantId: user.tenant_id, actorId: user.id, actorName: user.full_name,
    metadata: { sessionsRevoked: revoked },
  });

  return ok({ reset: true, sessionsRevoked: revoked,
    message: 'Your password has been changed. Sign in with your new password.' }, { ctx });
}, { ...PUBLIC, rateLimit: 'auth.forgot' });

router.post('/change-password', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    currentPassword: { type: 'string', required: true, max: 256 },
    newPassword: { type: 'string', required: true, max: 256 },
  });

  const db = new Db(ctx.env.DB);
  const user = await db.findOne('users', { id: ctx.userId });
  if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
    throw new ValidationError('Current password is not correct.', { currentPassword: 'That is not your current password.' });
  }
  if (input.currentPassword === input.newPassword) {
    throw new ValidationError('Choose a different password.', { newPassword: 'The new password must differ from the old one.' });
  }

  const policy = await getSecurityPolicy(db, ctx.tenantId);
  const check = checkPasswordPolicy(input.newPassword, {
    minLength: policy.password_min_length,
    requireMixed: !!policy.password_require_mixed,
    identity: [user.email, user.full_name],
  });
  if (!check.ok) throw new ValidationError('Choose a stronger password.', { newPassword: check.errors.join(' ') });

  await db.update('users', { id: ctx.userId }, {
    password_hash: await hashPassword(input.newPassword),
    must_change_password: 0,
    updated_at: nowIso(),
  });
  const revoked = await revokeAllUserSessions(db, ctx.userId, {
    exceptSessionId: ctx.session?.id, reason: 'password_changed',
  });

  auditAsync(ctx, {
    action: 'auth.password_changed', category: 'auth', severity: 'notice',
    entityType: 'user', entityId: ctx.userId, entityLabel: user.email,
    metadata: { otherSessionsRevoked: revoked },
  });

  return ok({ changed: true, otherSessionsRevoked: revoked }, { ctx });
}, { allowPasswordChange: true, allowPending2fa: true });

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
router.post('/logout', async (ctx) => {
  if (ctx.session) {
    const db = new Db(ctx.env.DB);
    await revokeSession(db, ctx.session.id, 'signed_out');
    auditAsync(ctx, { action: 'auth.logout', category: 'auth', entityType: 'session', entityId: ctx.session.id });
  }
  return ok({ signedOut: true }, { ctx });
}, { allowPending2fa: true, allowPasswordChange: true });

router.get('/sessions', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const rows = await listUserSessions(db, ctx.userId);
  return ok(rows.map(s => ({
    id: s.id,
    current: s.id === ctx.session?.id,
    ip: s.ip,
    userAgent: s.user_agent,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    expiresAt: s.expires_at,
    revokedAt: s.revoked_at,
    active: !s.revoked_at && !isPast(s.expires_at),
  })), { ctx });
});

router.delete('/sessions/:id', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const session = await db.findOne('sessions', { id: ctx.params.id });
  if (!session || session.user_id !== ctx.userId) {
    // An admin may revoke another user's session, with the right permission.
    if (!session || !ctx.has('sessions.revoke') || session.tenant_id !== ctx.tenantId) {
      throw new NotFoundError('Session');
    }
  }
  await revokeSession(db, session.id, 'revoked_by_user');
  auditAsync(ctx, {
    action: 'auth.session_revoked', category: 'security', severity: 'notice',
    entityType: 'session', entityId: session.id,
  });
  return ok({ revoked: true }, { ctx });
});

router.post('/sessions/revoke-others', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const count = await revokeAllUserSessions(db, ctx.userId, {
    exceptSessionId: ctx.session?.id, reason: 'revoked_by_user',
  });
  auditAsync(ctx, { action: 'auth.session_revoked', category: 'security', metadata: { count } });
  return ok({ revoked: count }, { ctx });
});

// ---------------------------------------------------------------------------
// Bootstrap — everything the SPA needs to render the shell in one call.
// ---------------------------------------------------------------------------
router.get('/me', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const entitlements = await entitlementsPayload(ctx);
  const navigation = await navigationFor(ctx, entitlements);

  const companies = ctx.tenantId
    ? await db.many(
        ctx.companyScope
          ? `SELECT id, name, gstin, pan, tan, state_code, status FROM companies
              WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${ctx.companyScope.map(() => '?').join(',')})
              ORDER BY name`
          : `SELECT id, name, gstin, pan, tan, state_code, status FROM companies
              WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 200`,
        ctx.companyScope ? [ctx.tenantId, ...ctx.companyScope] : [ctx.tenantId])
    : [];

  const branding = ctx.tenantId
    ? await db.findOne('white_label_settings', { tenant_id: ctx.tenantId })
    : null;

  const unreadNotifications = ctx.tenantId
    ? await db.count(
        'SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', [ctx.userId])
    : 0;

  return ok({
    user: publicUser(ctx.user, ctx.roles),
    tenant: ctx.tenant ? {
      id: ctx.tenant.id, name: ctx.tenant.name, slug: ctx.tenant.slug,
      status: ctx.tenant.status, gstin: ctx.tenant.gstin, stateCode: ctx.tenant.state_code,
      currency: ctx.tenant.currency, timezone: ctx.tenant.timezone,
      isDemo: !!ctx.tenant.is_demo, franchiseId: ctx.tenant.franchise_id,
    } : null,
    roles: ctx.roles.map(r => ({ key: r.key, name: r.name, level: r.level })),
    permissions: [...ctx.permissions],
    companies,
    activeCompanyId: ctx.activeCompanyId,
    entitlements,
    navigation,
    landing: landingPathFor(ctx.roleKeys),
    unreadNotifications,
    branding: branding && branding.enabled ? {
      productName: branding.product_name,
      logoKey: branding.logo_key,
      faviconKey: branding.favicon_key,
      primaryColour: branding.primary_colour,
      accentColour: branding.accent_colour,
      hidePoweredBy: !!branding.hide_powered_by,
      supportEmail: branding.support_email,
      supportPhone: branding.support_phone,
    } : null,
    demoMode: String(ctx.env.DEMO_MODE) === 'true',
    serverTime: nowIso(),
  }, { ctx });
}, { allowPasswordChange: true });

/** Switch the active company (multi-company add-on). */
router.post('/active-company', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, { companyId: { type: 'id', required: true } });

  const scope = scopeFor(ctx);
  const company = await scope.first('companies', { id: input.companyId });
  if (!company) throw new NotFoundError('Company');

  const db = new Db(ctx.env.DB);
  if (ctx.session) await setActiveCompany(db, ctx.session.id, company.id);

  return ok({ activeCompanyId: company.id, company: { id: company.id, name: company.name, gstin: company.gstin } }, { ctx });
}, { permission: 'companies.switch' });

/** The role & permission reference used by the Roles settings screen. */
router.get('/permissions-catalogue', async (ctx) => {
  return ok({
    permissions: PERMISSIONS,
    roles: [...ROLE_MAP.values()].map(r => ({
      key: r.key, name: r.name, level: r.level,
      description: r.description, accessLevel: r.accessLevel,
      landing: r.landing,
      permissions: r.permissions.includes('*') ? ['*'] : r.permissions,
      permissionCount: r.permissions.includes('*') ? PERMISSIONS.length : r.permissions.length,
    })),
  }, { ctx });
}, { anyPermission: ['roles.view', 'users.view'] });

// ---------------------------------------------------------------------------

function publicUser(user, roles = []) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    phone: user.phone,
    jobTitle: user.job_title,
    avatarKey: user.avatar_key,
    tenantId: user.tenant_id,
    branchId: user.branch_id,
    status: user.status,
    twoFactorEnabled: !!user.twofa_enabled,
    mustChangePassword: !!user.must_change_password,
    theme: user.theme,
    locale: user.locale,
    timezone: user.timezone,
    lastLoginAt: user.last_login_at,
    isDemo: !!user.is_demo,
    roles: roles.filter(Boolean).map(r => ({ key: r.key, name: r.name })),
    initials: initialsOf(user.full_name),
  };
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function brandName(ctx) {
  return ctx.env.APP_NAME || 'Meet Millions Finance CRM';
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as authRouter, publicUser, initialsOf };
