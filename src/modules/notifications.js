/**
 * The notification centre, delivery history, preferences and templates.
 *
 * The in-app feed is always available. The other channels are only as good as
 * their vendor credentials, so this module reports each channel's real state
 * — configured, locked behind an add-on, or off by the user's own choice —
 * rather than showing a switch that quietly does nothing.
 *
 * Preferences resolve the way the dispatcher resolves them: a tenant-wide row
 * is the floor, a user row overrides it, and a per-trigger row overrides the
 * `*` row. Reading them any other way here would show people settings that do
 * not match what they actually receive.
 */

import { createRouter } from '../http/router.js';
import { ok, paginated } from '../http/response.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addDays } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { getEntitlements } from '../services/features.js';
import {
  dispatchNotification, markNotificationsRead, render,
  CHANNEL_FEATURE, NOTIFICATION_CHANNELS,
} from '../services/notifications.js';
import { describeAllIntegrations } from '../services/integrations.js';
import { NOTIFICATION_TRIGGERS, TRIGGER_MAP } from '../data/notification-triggers.js';

const router = createRouter();

const CHANNEL_KEYS = NOTIFICATION_CHANNELS.map(c => c.key);
const CHANNEL_COLUMN = Object.fromEntries(CHANNEL_KEYS.map(k => [k, `${k}_enabled`]));

/** Which vendor actually carries each channel, for the "not connected" notice. */
const CHANNEL_PROVIDERS = {
  email: 'ses',
  sms: 'msg91',
  whatsapp: 'whatsapp',
  push: 'fcm',
  in_app: null,
};

/**
 * Triggers nobody may switch off.
 *
 * These are the ones that tell you your account was taken over. A preference
 * screen that lets someone silence them is a foothold for whoever took it.
 */
const MANDATORY_TRIGGERS = new Set([
  'account.password_changed',
  'account.password_reset',
  'security.login_anomaly',
  'security.2fa_enabled',
]);

// ---------------------------------------------------------------------------
// The bell menu and the feed
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const { page, pageSize } = ctx.pagination({ defaultSize: 20, maxSize: 100 });

  // Same reason as the count below: a tenantless actor has an empty feed, not
  // a broken one, and the bell must open for them like anybody else.
  if (!ctx.tenantId) {
    return paginated([], { page, pageSize, total: 0, unread: 0 }, ctx);
  }

  const scope = scopeFor(ctx);

  const where = scope.where('notifications', 'n');
  where.add('n.user_id = ?', ctx.userId);
  if (ctx.qBool('unreadOnly')) where.add('n.read_at IS NULL');
  where.eqIf('n.severity', ctx.q('severity'));
  where.eqIf('n.trigger_key', ctx.q('trigger'));

  const { rows, total } = await scope.paginate('notifications', where, {
    columns: 'n.*',
    alias: 'n',
    orderBy: `n.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'severity'], 'created_at')}`,
    page, pageSize,
  });

  const unread = await scope.rawCount(
    'SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL',
    [ctx.tenantId, ctx.userId]);

  return paginated(rows.map(toNotification), { page, pageSize, total, unread }, ctx);
}, { auth: true });

/** Just the badge count, for polling without pulling the whole feed. */
router.get('/unread-count', async (ctx) => {
  // Notifications carry a tenant by definition (the column is NOT NULL), so a
  // platform Super Admin has none. Zero is the true answer.
  if (!ctx.tenantId) return ok({ unread: 0, urgent: 0 }, { ctx });

  const scope = scopeFor(ctx);
  const unread = await scope.rawCount(
    'SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL',
    [ctx.tenantId, ctx.userId]);
  const urgent = await scope.rawCount(
    `SELECT COUNT(*) AS n FROM notifications
      WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL AND severity IN ('warning','danger')`,
    [ctx.tenantId, ctx.userId]);
  return ok({ unread, urgent }, { ctx });
}, { auth: true });

router.post('/read', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    ids: { type: 'array', max: 200, of: { type: 'id' } },
    all: { type: 'boolean', default: false },
  });
  if (!input.all && !input.ids?.length) {
    throw new BadRequestError('Send either a list of ids or { all: true }.');
  }

  const db = new Db(ctx.env.DB);
  const marked = await markNotificationsRead(db, ctx.userId, input.all ? null : input.ids);
  return ok({ marked }, { ctx });
}, { auth: true });

router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const row = await scope.first('notifications', { id: ctx.params.id, user_id: ctx.userId });
  if (!row) throw new NotFoundError('Notification');
  await scope.delete('notifications', row.id);
  return ok({ id: row.id, removed: true }, { ctx });
}, { auth: true });

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
router.get('/preferences', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('notification_preferences', {}, { order: 'trigger_key ASC', limit: 500 });
  const mine = rows.filter(r => r.user_id === ctx.userId || r.user_id === null);

  const entitlements = await getEntitlements(ctx);
  const integrations = await describeAllIntegrations(ctx);
  const byKey = new Map(integrations.map(i => [i.key, i]));

  // What each channel can actually do right now, and why not when it cannot.
  const channels = NOTIFICATION_CHANNELS.map((channel) => {
    const featureKey = CHANNEL_FEATURE[channel.key] ?? null;
    const featureOk = !featureKey || entitlements.features.has(featureKey);
    const providerKey = CHANNEL_PROVIDERS[channel.key];
    const provider = providerKey ? byKey.get(providerKey) : null;
    const configured = channel.key === 'in_app' ? true : !!provider?.configured;

    return {
      key: channel.key,
      name: channel.name,
      icon: channel.icon,
      requiresAddOn: channel.addOn,
      requiresFeature: featureKey,
      featureUnlocked: featureOk,
      providerName: provider?.name ?? null,
      providerConfigured: configured,
      available: featureOk && configured,
      unavailableReason: !featureOk
        ? `This channel needs the ${channel.addOn?.replace(/_/g, ' ') ?? 'relevant'} add-on.`
        : (configured ? null : `${provider?.name ?? 'The provider'} has no credentials yet.`),
      missingKeys: provider?.missingKeys ?? [],
    };
  });

  const resolved = (triggerKey) => resolveFromRows(mine, triggerKey);

  return ok({
    channels,
    defaults: resolved('*'),
    triggers: NOTIFICATION_TRIGGERS.map((trigger) => {
      const settings = resolved(trigger.key);
      return {
        key: trigger.key,
        name: trigger.name,
        category: trigger.category,
        audience: trigger.audience,
        defaultChannels: trigger.defaultChannels,
        // A trigger that cannot be turned off is marked, not hidden: people
        // should know a security alert will reach them regardless.
        mandatory: MANDATORY_TRIGGERS.has(trigger.key),
        channels: Object.fromEntries(CHANNEL_KEYS.map(k => [k, !!settings[CHANNEL_COLUMN[k]]])),
        customised: mine.some(r => r.user_id === ctx.userId && r.trigger_key === trigger.key),
      };
    }),
  }, { ctx });
}, { auth: true });

router.put('/preferences', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const entries = Array.isArray(body?.preferences) ? body.preferences : null;
  if (!entries) {
    throw new BadRequestError('Send { preferences: [{ triggerKey, channels: { email: true, ... } }] }.');
  }
  if (entries.length > 200) throw new BadRequestError('Change at most 200 triggers at a time.');

  const db = new Db(ctx.env.DB);
  const applied = [];
  const rejected = [];

  for (const entry of entries) {
    const triggerKey = entry?.triggerKey;
    if (triggerKey !== '*' && !TRIGGER_MAP.has(triggerKey)) {
      rejected.push({ triggerKey: triggerKey ?? null, reason: 'unknown_trigger' });
      continue;
    }
    const wanted = entry?.channels;
    if (!wanted || typeof wanted !== 'object') {
      rejected.push({ triggerKey, reason: 'no channels given' });
      continue;
    }

    const existing = await scope.first('notification_preferences',
      { user_id: ctx.userId, trigger_key: triggerKey });
    const patch = {};
    let refusedMandatory = false;

    for (const [channel, enabled] of Object.entries(wanted)) {
      if (!CHANNEL_COLUMN[channel]) continue;
      if (MANDATORY_TRIGGERS.has(triggerKey) && enabled === false) {
        refusedMandatory = true;
        continue;
      }
      patch[CHANNEL_COLUMN[channel]] = enabled ? 1 : 0;
    }

    if (refusedMandatory && !Object.keys(patch).length) {
      rejected.push({
        triggerKey,
        reason: `${TRIGGER_MAP.get(triggerKey)?.name ?? triggerKey} cannot be turned off — it concerns the security of your account.`,
      });
      continue;
    }
    if (!Object.keys(patch).length) {
      rejected.push({ triggerKey, reason: 'no recognised channels' });
      continue;
    }

    if (existing) {
      await scope.update('notification_preferences', existing.id, patch);
    } else {
      await scope.insert('notification_preferences', {
        id: ID.rule(), user_id: ctx.userId, trigger_key: triggerKey, ...patch,
      });
    }
    applied.push({ triggerKey, channels: patch, mandatoryKept: refusedMandatory });
  }

  const rows = await scope.all('notification_preferences', {}, { limit: 500 });
  const mine = rows.filter(r => r.user_id === ctx.userId || r.user_id === null);

  return ok({
    applied,
    rejected,
    effectiveDefaults: resolveFromRows(mine, '*'),
  }, { ctx });
}, { auth: true });

/** Reset this user's overrides and fall back to the organisation's defaults. */
router.delete('/preferences', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const result = await db.run(
    'DELETE FROM notification_preferences WHERE tenant_id = ? AND user_id = ?',
    [ctx.tenantId, ctx.userId]);
  return ok({ cleared: result.meta?.changes ?? 0 }, { ctx });
}, { auth: true });

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
router.get('/templates', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const rows = await db.many(
    `SELECT * FROM notification_templates
      WHERE tenant_id = ? OR tenant_id IS NULL
      ORDER BY trigger_key ASC, channel ASC`, [ctx.tenantId]);

  // Platform rows are the baseline; a tenant row of the same key overrides it.
  const defaults = new Map();
  const overrides = new Map();
  for (const row of rows) {
    const key = `${row.trigger_key}:${row.channel}`;
    (row.tenant_id ? overrides : defaults).set(key, row);
  }

  return ok({
    templates: [...defaults.entries()].map(([key, base]) => {
      const override = overrides.get(key);
      const active = override ?? base;
      return {
        triggerKey: base.trigger_key,
        triggerName: TRIGGER_MAP.get(base.trigger_key)?.name ?? base.trigger_key,
        channel: base.channel,
        name: active.name,
        subject: active.subject,
        body: active.body,
        isCustomised: !!override,
        // The placeholders this trigger actually supplies. Offering them beats
        // leaving an author to guess a name and ship a message reading "Dear ,".
        variables: placeholdersIn(`${base.subject ?? ''} ${base.body}`),
        defaultSubject: base.subject,
        defaultBody: base.body,
      };
    }),
  }, { ctx });
}, { permission: 'notifications.manage' });

router.put('/templates/:triggerKey/:channel', async (ctx) => {
  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const { triggerKey, channel } = ctx.params;

  const base = await db.one(
    'SELECT * FROM notification_templates WHERE trigger_key = ? AND channel = ? AND tenant_id IS NULL LIMIT 1',
    [triggerKey, channel]);
  if (!base) throw new NotFoundError('Template');

  const body = await ctx.body();
  const input = validate(body, {
    subject: { type: 'string', max: 200 },
    body: { type: 'text', max: 8000 },
    reset: { type: 'boolean', default: false },
  });

  const existing = await scope.first('notification_templates', { trigger_key: triggerKey, channel });

  if (input.reset) {
    if (existing) await scope.delete('notification_templates', existing.id);
    return ok({
      reset: true, triggerKey, channel, subject: base.subject, body: base.body,
    }, { ctx });
  }
  if (!input.body) throw new BadRequestError('A template needs a body.');

  // A placeholder the dispatcher will never fill renders as an empty string,
  // which is how a message goes out reading "Dear ,". Refuse it instead.
  const known = new Set(placeholdersIn(`${base.subject ?? ''} ${base.body}`));
  const used = placeholdersIn(`${input.subject ?? ''} ${input.body}`);
  const unknown = used.filter(v => !known.has(v));
  if (unknown.length) {
    throw new BadRequestError(
      `This template uses placeholders that ${TRIGGER_MAP.get(triggerKey)?.name ?? triggerKey} never provides: `
      + `${unknown.join(', ')}. Available: ${[...known].join(', ') || 'none'}.`);
  }

  if (existing) {
    await scope.update('notification_templates', existing.id, {
      subject: input.subject ?? null,
      body: input.body,
      variables_json: JSON.stringify(used),
    });
  } else {
    await scope.insert('notification_templates', {
      id: ID.template(),
      trigger_key: triggerKey,
      channel,
      name: base.name,
      subject: input.subject ?? null,
      body: input.body,
      variables_json: JSON.stringify(used),
      is_active: 1,
    });
  }

  await audit(ctx, {
    action: 'settings.updated', category: 'communication',
    entityType: 'notification_template', entityId: `${triggerKey}:${channel}`,
    entityLabel: TRIGGER_MAP.get(triggerKey)?.name ?? triggerKey,
    oldValue: { body: existing?.body ?? base.body },
    newValue: { body: input.body },
  });

  return ok({ triggerKey, channel, subject: input.subject ?? null, body: input.body }, { ctx });
}, { permission: 'notifications.manage' });

/** Render a template against sample values, without sending anything. */
router.post('/templates/:triggerKey/:channel/preview', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const { triggerKey, channel } = ctx.params;

  const row = await db.one(
    `SELECT * FROM notification_templates
      WHERE trigger_key = ? AND channel = ? AND (tenant_id = ? OR tenant_id IS NULL)
      ORDER BY (tenant_id IS NULL) ASC LIMIT 1`,
    [triggerKey, channel, ctx.tenantId]);
  if (!row) throw new NotFoundError('Template');

  const body = await ctx.body();
  const input = validate(body, { variables: { type: 'json' } });

  // Sample values look like sample values. A preview that reads like a real
  // client's data invites someone to believe a message was actually sent.
  const names = placeholdersIn(`${row.subject ?? ''} ${row.body}`);
  const vars = {
    ...Object.fromEntries(names.map(v => [v, `[${v}]`])),
    appName: ctx.env.APP_NAME ?? 'Meet Millions Finance CRM',
    appUrl: ctx.env.APP_URL ?? '',
    organisation: ctx.tenant?.name ?? '[organisation]',
    name: ctx.user.full_name,
    ...(input.variables ?? {}),
  };

  return ok({
    triggerKey,
    channel,
    subject: render(row.subject ?? '', vars),
    body: render(row.body, vars),
    variablesUsed: vars,
    sent: false,
    note: 'This is a preview. Nothing was sent.',
  }, { ctx });
}, { permission: 'notifications.manage' });

/** Send one real message to yourself, to confirm a channel works end to end. */
router.post('/test', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    channel: { type: 'enum', required: true, values: CHANNEL_KEYS },
  });

  const result = await dispatchNotification(ctx, {
    triggerKey: 'account.registered',
    userId: ctx.userId,
    channels: [input.channel],
    variables: {
      name: ctx.user.full_name,
      organisation: ctx.tenant?.name ?? 'your organisation',
    },
  });

  // The honest answer either way: delivered, or the reason it was not.
  return ok({
    channel: input.channel,
    delivered: result.summary.sent > 0,
    summary: result.summary,
    deliveries: result.deliveries.map(d => ({
      channel: d.channel,
      status: d.status,
      provider: d.provider ?? null,
      error: d.error_message ?? d.error ?? null,
    })),
  }, { ctx });
}, { permission: 'notifications.manage' });

// ---------------------------------------------------------------------------
// Delivery history — what was actually sent, and what was not
// ---------------------------------------------------------------------------
router.get('/deliveries', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('message_deliveries', 'md');
  where.eqIf('md.channel', ctx.q('channel'));
  where.eqIf('md.status', ctx.q('status'));
  where.eqIf('md.trigger_key', ctx.q('trigger'));
  where.eqIf('md.client_id', ctx.q('clientId'));
  where.betweenIf('md.created_at', ctx.q('from'), ctx.q('to'));
  where.searchIf(['md.to_address', 'md.subject'], ctx.q('q'));

  const { rows, total } = await scope.paginate('message_deliveries', where, {
    columns: 'md.*, u.full_name AS recipient_name',
    joins: 'LEFT JOIN users u ON u.id = md.to_user_id',
    alias: 'md',
    orderBy: 'md.created_at DESC',
    page, pageSize,
  });

  const counts = await scope.raw(
    `SELECT status, COUNT(*) AS n FROM message_deliveries
      WHERE tenant_id = ? AND created_at >= ? GROUP BY status`,
    [ctx.tenantId, addDays(-30)]);

  return paginated(rows.map(d => ({
    id: d.id,
    channel: d.channel,
    provider: d.provider,
    triggerKey: d.trigger_key,
    recipient: d.to_address,
    recipientName: d.recipient_name ?? null,
    subject: d.subject,
    // `skipped` and `not_configured` are outcomes in their own right, not
    // failures: the system deliberately did not send, and the row says why.
    status: d.status,
    errorCode: d.error_code,
    error: d.error_message,
    attempts: d.attempts,
    deliveredAt: d.delivered_at,
    openedAt: d.opened_at,
    createdAt: d.created_at,
  })), {
    page, pageSize, total,
    last30Days: Object.fromEntries(counts.map(c => [c.status, Number(c.n)])),
  }, ctx);
}, { permission: 'notifications.manage' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective setting for one trigger.
 *
 * Deliberately the same specificity order the dispatcher uses: tenant `*`,
 * then tenant trigger, then user `*`, then user trigger. If this drifted, the
 * settings screen would show people something other than what they receive.
 */
function resolveFromRows(rows, triggerKey) {
  const applicable = rows.filter(r => r.trigger_key === '*' || r.trigger_key === triggerKey);
  const rank = (r) => (r.user_id ? 2 : 0) + (r.trigger_key === '*' ? 0 : 1);
  const sorted = [...applicable].sort((a, b) => rank(a) - rank(b));

  const merged = {
    email_enabled: 1, sms_enabled: 0, whatsapp_enabled: 0, in_app_enabled: 1, push_enabled: 1,
  };
  for (const row of sorted) {
    for (const key of Object.keys(merged)) {
      if (row[key] !== null && row[key] !== undefined) merged[key] = row[key];
    }
  }
  return merged;
}

function placeholdersIn(text) {
  const found = [...String(text ?? '').matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map(m => m[1]);
  return [...new Set(found)];
}

function toNotification(n) {
  return {
    id: n.id,
    triggerKey: n.trigger_key,
    title: n.title,
    body: n.body,
    severity: n.severity,
    icon: n.icon,
    linkPath: n.link_path,
    entityType: n.entity_type,
    entityId: n.entity_id,
    read: !!n.read_at,
    readAt: n.read_at,
    createdAt: n.created_at,
  };
}

export { router as notificationsRouter };
