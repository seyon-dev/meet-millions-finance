/**
 * The subscription ledger.
 *
 * Audit logs answer "who did what", but they are purged on a retention
 * schedule and their payloads are free-form JSON. Billing questions live
 * longer than that — "what plan was this organisation on in March", "when was
 * their period last extended", "how many reminders have we sent them" — so
 * every subscription-affecting change also lands here, append-only, in a
 * shape a screen can render without parsing prose.
 */

import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';

export const SUBSCRIPTION_EVENT_KINDS = [
  'plan_changed', 'period_extended', 'trial_extended', 'status_changed',
  'payment_recorded', 'reminder_sent', 'renewed', 'suspended', 'reactivated', 'note',
];

export async function recordSubscriptionEvent(db, {
  tenantId, subscriptionId = null, kind, actorId = null, actorName = null,
  oldValue = null, newValue = null, note = null,
}) {
  const event = {
    id: ID.subscriptionEvent(),
    tenant_id: tenantId,
    subscription_id: subscriptionId,
    kind,
    actor_id: actorId,
    actor_name: actorName,
    old_value_json: oldValue ? JSON.stringify(oldValue) : null,
    new_value_json: newValue ? JSON.stringify(newValue) : null,
    note,
    created_at: nowIso(),
  };
  await db.insert('subscription_events', event);
  return event;
}

export async function listSubscriptionEvents(db, tenantId, { limit = 30 } = {}) {
  const rows = await db.many(
    `SELECT * FROM subscription_events WHERE tenant_id = ?
      ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 30, 1), 200)}`,
    [tenantId]);
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    actorName: r.actor_name,
    oldValue: safeParse(r.old_value_json),
    newValue: safeParse(r.new_value_json),
    note: r.note,
    createdAt: r.created_at,
  }));
}

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
