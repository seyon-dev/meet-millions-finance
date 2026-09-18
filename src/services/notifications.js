/**
 * The notification engine.
 *
 * One call — `dispatchNotification(ctx, {...})` — fans a single business event
 * out across every channel the tenant has enabled and is entitled to use:
 * in-app, email, SMS, WhatsApp and push.
 *
 * Honesty rules this engine keeps:
 *   - A delivery row is written for every attempt, with the provider's real
 *     outcome. `not_configured` is a first-class status, distinct from `failed`.
 *   - A channel whose add-on is not active is recorded as `skipped`, not sent.
 *   - In-app notifications always work, with no vendor involved, so a user
 *     never misses an event because a third party is unconfigured.
 */

import { Db } from '../db/client.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { escapeHtml } from '../utils/validate.js';
import {
  TRIGGER_MAP, IN_APP_DEFAULTS, NOTIFICATION_CHANNELS,
} from '../data/notification-triggers.js';
import { SesProvider, Msg91Provider, WhatsAppProvider, FcmProvider } from '../integrations/messaging.js';
import { getEntitlements } from './features.js';

/** Channels and the capability each one needs. */
const CHANNEL_FEATURE = {
  email: null,            // always available
  in_app: null,           // always available
  sms: 'sms_automation',
  whatsapp: 'whatsapp_integration',
  push: 'mobile_app',
};

/**
 * Send a notification for a business event.
 *
 * @param {object} ctx  request context (for env and tenant)
 * @param {object} options
 * @param {string} options.triggerKey
 * @param {string} [options.tenantId]
 * @param {string} [options.userId]        a single recipient
 * @param {string[]} [options.userIds]     several recipients
 * @param {string} [options.clientId]      the client this concerns
 * @param {object} [options.variables]     placeholder values
 * @param {string[]} [options.channels]    override the default channel set
 * @param {object} [options.link]          { path } deep link for the in-app item
 * @returns {Promise<{deliveries: object[], notifications: object[], summary: object}>}
 */
export async function dispatchNotification(ctx, {
  triggerKey, tenantId, userId, userIds, clientId = null,
  variables = {}, channels = null, link = null, entityType = null, entityId = null,
  toEmail = null, toPhone = null,
}) {
  const db = new Db(ctx.env.DB);
  const tid = tenantId ?? ctx.tenantId;
  const trigger = TRIGGER_MAP.get(triggerKey);

  const summary = { trigger: triggerKey, sent: 0, skipped: 0, failed: 0, notConfigured: 0 };
  const deliveries = [];
  const notifications = [];

  if (!trigger) {
    // An unknown trigger is a programming error, not a user-facing failure.
    console.warn('unknown notification trigger', triggerKey);
    return { deliveries, notifications, summary };
  }

  const recipientIds = [...new Set([...(userIds ?? []), ...(userId ? [userId] : [])])];
  const recipients = recipientIds.length
    ? await db.many(
        `SELECT id, email, phone, full_name, tenant_id FROM users
          WHERE id IN (${recipientIds.map(() => '?').join(',')}) AND deleted_at IS NULL
            AND status IN ('active','invited')`, recipientIds)
    : [];

  // Anonymous recipients (a password reset for an address with no session yet,
  // or a client contact with no portal login) still get their email or SMS.
  if (!recipients.length && (toEmail || toPhone)) {
    recipients.push({ id: null, email: toEmail, phone: toPhone, full_name: variables.name ?? '', tenant_id: tid });
  }
  if (!recipients.length) return { deliveries, notifications, summary };

  const wanted = channels ?? trigger.defaultChannels;
  const vars = { ...baseVariables(ctx), ...variables };

  // Which channels this tenant may actually use right now.
  const entitlements = tid ? await getEntitlements({ ...ctx, tenantId: tid }) : null;
  const allowed = new Set();
  for (const channel of wanted) {
    const feature = CHANNEL_FEATURE[channel];
    if (!feature) { allowed.add(channel); continue; }
    if (entitlements?.features?.has(feature)) allowed.add(channel);
  }

  for (const recipient of recipients) {
    const prefs = recipient.id
      ? await resolvePreferences(db, tid, recipient.id, triggerKey)
      : { email_enabled: 1, sms_enabled: 1, whatsapp_enabled: 1, in_app_enabled: 0, push_enabled: 0 };

    for (const channel of wanted) {
      const enabled = prefs[`${channel}_enabled`];
      if (!enabled) { summary.skipped++; continue; }

      if (!allowed.has(channel)) {
        // The user wants it, but the add-on is not active. Record it plainly.
        deliveries.push(await recordDelivery(db, tid, {
          channel, triggerKey, toUserId: recipient.id,
          toAddress: addressFor(channel, recipient) ?? 'n/a',
          status: 'skipped',
          errorCode: 'addon_inactive',
          errorMessage: `${labelFor(channel)} is not active on this plan.`,
          clientId, entityType, entityId,
        }));
        summary.skipped++;
        continue;
      }

      const result = await sendOnChannel(ctx, db, {
        channel, trigger, triggerKey, recipient, vars, tid, clientId, link, entityType, entityId,
      });

      if (result.delivery) deliveries.push(result.delivery);
      if (result.notification) notifications.push(result.notification);

      if (result.status === 'sent' || result.status === 'delivered') summary.sent++;
      else if (result.status === 'not_configured') summary.notConfigured++;
      else if (result.status === 'skipped') summary.skipped++;
      else summary.failed++;
    }
  }

  return { deliveries, notifications, summary };
}

// ---------------------------------------------------------------------------

async function sendOnChannel(ctx, db, {
  channel, trigger, triggerKey, recipient, vars, tid, clientId, link, entityType, entityId,
}) {
  if (channel === 'in_app') {
    if (!recipient.id) return { status: 'skipped' };
    const spec = IN_APP_DEFAULTS[triggerKey] ?? { title: trigger.name, severity: 'info', icon: 'bell' };
    const notification = {
      id: ID.notification(),
      tenant_id: tid,
      user_id: recipient.id,
      trigger_key: triggerKey,
      title: render(spec.title, vars),
      body: vars.body ? render(String(vars.body).slice(0, 500), vars) : null,
      severity: spec.severity,
      icon: spec.icon,
      link_path: link?.path ?? vars.linkPath ?? null,
      entity_type: entityType,
      entity_id: entityId,
      read_at: null,
      created_at: nowIso(),
    };
    await db.insert('notifications', notification);
    return { status: 'sent', notification };
  }

  const template = await resolveTemplate(db, tid, triggerKey, channel);
  const address = addressFor(channel, recipient);

  if (!address) {
    return {
      status: 'skipped',
      delivery: await recordDelivery(db, tid, {
        channel, triggerKey, toUserId: recipient.id, toAddress: 'unknown',
        status: 'skipped', errorCode: 'no_address',
        errorMessage: `No ${channel === 'email' ? 'email address' : channel === 'push' ? 'device token' : 'phone number'} on file for this recipient.`,
        clientId, entityType, entityId,
      }),
    };
  }

  const subject = template?.subject ? render(template.subject, vars) : render(trigger.name, vars);
  const body = template?.body ? render(template.body, vars) : defaultBody(trigger, vars);

  const delivery = await recordDelivery(db, tid, {
    channel, triggerKey, templateId: template?.id ?? null,
    toUserId: recipient.id, toAddress: address,
    subject, body, status: 'sending', clientId, entityType, entityId,
  });

  const result = await callProvider(ctx, {
    channel, address, subject, body, vars, template, recipient, db, tid,
  });

  const patch = {
    status: result.ok ? 'sent' : (result.status === 'not_configured' ? 'not_configured' : 'failed'),
    provider: result.provider,
    provider_message_id: result.providerId ?? null,
    error_code: result.ok ? null : result.error?.code ?? null,
    error_message: result.ok ? null : result.error?.message ?? null,
    attempts: 1,
    delivered_at: result.ok ? nowIso() : null,
    updated_at: nowIso(),
  };
  await db.update('message_deliveries', { id: delivery.id }, patch);

  return { status: patch.status, delivery: { ...delivery, ...patch } };
}

async function callProvider(ctx, { channel, address, subject, body, vars, template, recipient, db, tid }) {
  switch (channel) {
    case 'email': {
      const provider = new SesProvider(ctx.env);
      const res = await provider.send({
        to: address, subject,
        text: body,
        html: htmlShell({ subject, body, vars }),
      });
      return { ...res, provider: provider.key };
    }
    case 'sms': {
      const provider = new Msg91Provider(ctx.env);
      const res = await provider.send({ to: address, text: body, templateId: template?.provider_template_id });
      return { ...res, provider: provider.key };
    }
    case 'whatsapp': {
      const provider = new WhatsAppProvider(ctx.env);
      // An approved template is required to open a conversation; free text is
      // only valid inside the 24-hour window, which the inbox tracks.
      const res = template?.provider_template_id
        ? await provider.sendTemplate({
            to: address,
            templateName: template.provider_template_id,
            bodyParams: templateParams(template, vars),
          })
        : await provider.sendText({ to: address, text: body });
      return { ...res, provider: provider.key };
    }
    case 'push': {
      const provider = new FcmProvider(ctx.env);
      const tokens = recipient.id
        ? await db.many('SELECT token FROM push_tokens WHERE user_id = ? AND is_active = 1 LIMIT 10', [recipient.id])
        : [];
      if (!tokens.length) {
        return { ok: false, status: 'failed', provider: provider.key,
          error: { code: 'no_device', message: 'No registered device for this user.' } };
      }
      const res = await provider.send({
        token: tokens[0].token, title: subject, body: body.slice(0, 240), data: { trigger: vars.triggerKey ?? '' },
      });
      return { ...res, provider: provider.key };
    }
    default:
      return { ok: false, status: 'failed', provider: null,
        error: { code: 'unknown_channel', message: `Unknown channel: ${channel}` } };
  }
}

function templateParams(template, vars) {
  const declared = safeJson(template.variables_json, null);
  if (Array.isArray(declared)) return declared.map(k => vars[k] ?? '');
  // Fall back to the placeholders present in the body, in order.
  const found = [...String(template.body ?? '').matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
  return [...new Set(found)].map(k => vars[k] ?? '');
}

// ---------------------------------------------------------------------------

async function recordDelivery(db, tenantId, {
  channel, triggerKey, templateId = null, toUserId, toAddress, subject = null, body = null,
  status = 'queued', errorCode = null, errorMessage = null, clientId = null,
  entityType = null, entityId = null, campaignId = null,
}) {
  const row = {
    id: ID.delivery(),
    tenant_id: tenantId,
    channel,
    provider: null,
    trigger_key: triggerKey,
    template_id: templateId,
    to_user_id: toUserId,
    to_address: toAddress,
    subject,
    body: body ? String(body).slice(0, 4000) : null,
    status,
    error_code: errorCode,
    error_message: errorMessage,
    attempts: 0,
    entity_type: entityType,
    entity_id: entityId,
    client_id: clientId,
    campaign_id: campaignId,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await db.insert('message_deliveries', row);
  return row;
}

/** Tenant default, then the user's own override for this trigger. */
async function resolvePreferences(db, tenantId, userId, triggerKey) {
  const rows = await db.many(
    `SELECT * FROM notification_preferences
      WHERE tenant_id = ?
        AND (user_id IS NULL OR user_id = ?)
        AND (trigger_key = ? OR trigger_key = '*')`,
    [tenantId, userId, triggerKey]);

  // Specificity order: tenant '*' < tenant trigger < user '*' < user trigger.
  const rank = (r) => (r.user_id ? 2 : 0) + (r.trigger_key === '*' ? 0 : 1);
  const sorted = rows.sort((a, b) => rank(a) - rank(b));

  const merged = { email_enabled: 1, sms_enabled: 0, whatsapp_enabled: 0, in_app_enabled: 1, push_enabled: 1 };
  for (const row of sorted) {
    for (const key of Object.keys(merged)) {
      if (row[key] !== null && row[key] !== undefined) merged[key] = row[key];
    }
  }
  return merged;
}

/** Tenant template first, platform default second. */
async function resolveTemplate(db, tenantId, triggerKey, channel) {
  return db.one(
    `SELECT * FROM notification_templates
      WHERE trigger_key = ? AND channel = ? AND is_active = 1
        AND (tenant_id = ? OR tenant_id IS NULL)
      ORDER BY (tenant_id IS NULL) ASC LIMIT 1`,
    [triggerKey, channel, tenantId]);
}

function addressFor(channel, recipient) {
  if (channel === 'email') return recipient.email || null;
  if (channel === 'sms' || channel === 'whatsapp') return recipient.phone || null;
  if (channel === 'push') return recipient.id ? `user:${recipient.id}` : null;
  return null;
}

function labelFor(channel) {
  return NOTIFICATION_CHANNELS.find(c => c.key === channel)?.name ?? channel;
}

function baseVariables(ctx) {
  return {
    appName: ctx.env?.APP_NAME || 'Meet Millions Finance CRM',
    appUrl: ctx.env?.APP_URL || '',
    organisation: ctx.tenant?.name ?? '',
    year: new Date().getFullYear(),
  };
}

/** Replace {{placeholders}}; an unknown placeholder renders as empty. */
export function render(template, vars) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' && /paise$/i.test(key)) return formatINR(value);
    return String(value);
  });
}

function defaultBody(trigger, vars) {
  return render(`${trigger.name}. Open ${vars.appUrl || 'the CRM'} for details.`, vars);
}

/**
 * The branded HTML shell around a plain-text email body. Deliberately simple,
 * table-free and inline-styled, because that is what email clients render
 * reliably. Every interpolated value is escaped.
 */
export function htmlShell({ subject, body, vars = {} }) {
  const appName = escapeHtml(vars.appName || 'Meet Millions Finance CRM');
  const appUrl = escapeHtml(vars.appUrl || '#');
  const paragraphs = String(body)
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 16px;line-height:1.6;color:#334155;font-size:15px;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#F6F8FC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #E1E8F4;">
    <div style="padding:20px 28px;background:linear-gradient(135deg,#2F6BFF 0%,#22D3EE 100%);">
      <span style="color:#FFFFFF;font-size:15px;font-weight:700;letter-spacing:-0.01em;">${appName}</span>
    </div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 20px;font-size:19px;line-height:1.3;color:#101A2E;font-weight:600;">${escapeHtml(subject)}</h1>
      ${paragraphs}
    </div>
    <div style="padding:18px 28px;background:#F6F8FC;border-top:1px solid #E1E8F4;">
      <p style="margin:0;font-size:12px;color:#6B7CA0;line-height:1.5;">
        Sent by ${appName}. <a href="${appUrl}" style="color:#2F6BFF;text-decoration:none;">Open the CRM</a>
      </p>
    </div>
  </div>
</body></html>`;
}

/** Mark a user's in-app notifications read. */
export async function markNotificationsRead(db, userId, ids = null) {
  if (ids?.length) {
    const meta = await db.run(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL
        AND id IN (${ids.map(() => '?').join(',')})`,
      [nowIso(), userId, ...ids]);
    return meta?.changes ?? 0;
  }
  const meta = await db.run(
    'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [nowIso(), userId]);
  return meta?.changes ?? 0;
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { CHANNEL_FEATURE, NOTIFICATION_CHANNELS };
