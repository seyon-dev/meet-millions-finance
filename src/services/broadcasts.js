/**
 * Broadcast delivery.
 *
 * `POST /messaging/broadcasts` resolved the audience, inserted a row, and
 * stopped. The comment on that insert said "Queued, not sent: the scheduler
 * delivers it" — describing a scheduler job that did not exist. Nothing in the
 * codebase read the table except the list endpoint, so:
 *
 *   * a scheduled broadcast was stored, reported as queued, and never sent —
 *     the silent failure;
 *   * an immediate one was inserted with status 'queued', which the CHECK
 *     constraint on that table did not allow, so it failed outright. That is
 *     the only reason this was ever noticed.
 *
 * Delivery is per recipient, in broadcast_recipients, rather than as counters
 * on the broadcast. Counters cannot tell you *who* a send failed for, cannot
 * be audited, and make a retry re-send to everybody who already got it.
 *
 * Honesty rules, the same ones the rest of the integration layer follows:
 *   * with no provider configured, nothing is marked sent. The broadcast fails
 *     with a reason naming the missing credentials.
 *   * a recipient is 'sent' only when the provider accepted it. A failure is
 *     recorded against that recipient with the provider's message.
 */

import { Db } from '../db/client.js';
import { TenantScope } from '../db/tenancy.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { WhatsAppProvider, SesProvider, Msg91Provider } from '../integrations/messaging.js';
import { logSystemEvent } from './logging.js';

/** Recipients per scheduler pass. A Worker has a request budget. */
const BATCH = 200;

/** How many times a failed recipient is retried before it is left alone. */
const MAX_ATTEMPTS = 3;

/**
 * The lifecycle, written down because the CHECK constraint now allows more
 * values than any one path uses:
 *
 *   draft      — created but not released (not currently reachable from the API)
 *   queued     — released, waiting for the next scheduler pass
 *   scheduled  — released, waiting for scheduled_at
 *   processing — a pass is working through its recipients
 *   sent       — every recipient reached a terminal state, at least one sent
 *   failed     — every recipient failed, or the provider is not configured
 *   cancelled  — stopped by a person before it finished
 */
export const ACTIVE_STATUSES = ['queued', 'scheduled', 'processing'];

function providerFor(channel, env) {
  if (channel === 'whatsapp') return new WhatsAppProvider(env);
  if (channel === 'email') return new SesProvider(env);
  if (channel === 'sms') return new Msg91Provider(env);
  return null;
}

/**
 * Write one row per recipient.
 *
 * Called when the broadcast is created, so the recipient list is fixed at the
 * moment somebody pressed send rather than re-resolved later — a client added
 * in between should not silently join a broadcast nobody reviewed.
 */
export async function stageRecipients(scope, broadcastId, recipients) {
  let staged = 0;
  for (const r of recipients) {
    try {
      await scope.insert('broadcast_recipients', {
        id: ID.broadcastRecipient(),
        broadcast_id: broadcastId,
        client_id: r.id ?? null,
        user_id: r.userId ?? null,
        to_address: String(r.to),
        status: 'pending',
        attempts: 0,
      });
      staged += 1;
    } catch (err) {
      // The unique index on (broadcast_id, to_address) de-duplicates an
      // audience that names the same number twice. Not an error.
      if (!/UNIQUE|constraint/i.test(err?.message ?? '')) throw err;
    }
  }
  return staged;
}

/**
 * Deliver one broadcast.
 *
 * Returns without sending anything when the channel's provider is not
 * configured — and says so on the broadcast, rather than leaving it queued
 * for ever with no explanation.
 */
export async function deliverBroadcast(env, broadcast, { limit = BATCH } = {}) {
  const db = new Db(env.DB);
  const scope = new TenantScope(db, broadcast.tenant_id);
  const provider = providerFor(broadcast.channel, env);

  if (!provider || !provider.isConfigured()) {
    await scope.update('broadcasts', broadcast.id, {
      status: 'failed',
      last_error: `${broadcast.channel} is not connected on this deployment, so nothing was sent.`,
      completed_at: nowIso(),
    });
    return { sent: 0, failed: 0, skipped: 0, notConfigured: true };
  }

  await scope.update('broadcasts', broadcast.id, {
    status: 'processing',
    started_at: broadcast.started_at ?? nowIso(),
  });

  const pending = await db.many(
    `SELECT * FROM broadcast_recipients
      WHERE broadcast_id = ? AND status IN ('pending','failed') AND attempts < ?
      ORDER BY created_at LIMIT ?`, [broadcast.id, MAX_ATTEMPTS, limit]);

  let sent = 0;
  let failed = 0;

  for (const recipient of pending) {
    const result = await sendOne(provider, broadcast, recipient);
    const ok = result?.ok === true;

    await scope.update('broadcast_recipients', recipient.id, {
      status: ok ? 'sent' : 'failed',
      provider_message_id: result?.data?.messageId ?? result?.providerId ?? null,
      error: ok ? null : (result?.error?.message ?? 'The provider rejected this message.'),
      attempts: (recipient.attempts ?? 0) + 1,
      sent_at: ok ? nowIso() : null,
    });

    if (ok) sent += 1; else failed += 1;
  }

  // Counters are derived from the recipient rows, never incremented blindly,
  // so they cannot drift from what actually happened.
  const tally = await db.one(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('sent','delivered') THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status = 'failed' AND attempts >= ? THEN 1 ELSE 0 END) AS dead,
        SUM(CASE WHEN status IN ('pending') OR (status = 'failed' AND attempts < ?) THEN 1 ELSE 0 END) AS remaining
       FROM broadcast_recipients WHERE broadcast_id = ?`,
    [MAX_ATTEMPTS, MAX_ATTEMPTS, broadcast.id]);

  const remaining = Number(tally?.remaining ?? 0);
  const sentTotal = Number(tally?.sent ?? 0);
  const dead = Number(tally?.dead ?? 0);

  await scope.update('broadcasts', broadcast.id, {
    sent_count: sentTotal,
    failed_count: dead,
    status: remaining > 0 ? 'processing' : (sentTotal > 0 ? 'sent' : 'failed'),
    completed_at: remaining > 0 ? null : nowIso(),
    last_error: remaining === 0 && sentTotal === 0
      ? 'Every recipient failed. See the per-recipient errors.' : null,
  });

  return { sent, failed, remaining, notConfigured: false };
}

async function sendOne(provider, broadcast, recipient) {
  try {
    if (broadcast.channel === 'whatsapp') {
      // Outside a 24-hour reply window WhatsApp only accepts a template, which
      // is why the API refuses a template-less WhatsApp broadcast up front.
      return await provider.sendTemplate({
        to: recipient.to_address,
        templateName: broadcast.template_name ?? broadcast.template_id,
        language: broadcast.template_language ?? 'en',
        bodyParams: [],
      });
    }
    if (broadcast.channel === 'email') {
      return await provider.send({
        to: recipient.to_address,
        subject: broadcast.name,
        text: broadcast.body ?? '',
      });
    }
    return await provider.send({ to: recipient.to_address, text: broadcast.body ?? '' });
  } catch (err) {
    return { ok: false, error: { message: err?.message ?? 'The provider threw.' } };
  }
}

/**
 * The scheduler pass: pick up everything due and deliver a batch of each.
 *
 * A broadcast larger than one batch stays 'processing' and is picked up again
 * on the next pass, so a 5,000-recipient send does not have to fit in one
 * Worker invocation.
 */
export async function runDueBroadcasts(env, { limit = 10 } = {}) {
  const db = new Db(env.DB);
  const due = await db.many(
    `SELECT * FROM broadcasts
      WHERE (status = 'queued')
         OR (status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?)
         OR (status = 'processing')
      ORDER BY created_at LIMIT ?`, [nowIso(), limit]);

  let processed = 0;
  let sent = 0;

  for (const broadcast of due) {
    try {
      const result = await deliverBroadcast(env, broadcast);
      processed += 1;
      sent += result.sent;
    } catch (err) {
      await logSystemEvent(env, {
        level: 'error', source: 'scheduler', event: 'broadcast_failed',
        message: `Broadcast "${broadcast.name}" failed: ${err?.message}`,
        tenantId: broadcast.tenant_id, context: { broadcastId: broadcast.id },
      }).catch(() => {});
      const scope = new TenantScope(db, broadcast.tenant_id);
      await scope.update('broadcasts', broadcast.id, {
        status: 'failed', last_error: err?.message ?? 'unknown error', completed_at: nowIso(),
      }).catch(() => {});
    }
  }

  return { due: due.length, processed, sent };
}
