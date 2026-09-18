/**
 * The WhatsApp chatbot.
 *
 * A flow is a small directed graph. Each node asks something and, based on
 * what comes back, moves to the next node or hands the conversation to a
 * person. The graph is stored as JSON on `chatbot_flows`; this module is the
 * only thing that interprets it.
 *
 * Two rules shape the design:
 *
 *   1. A bot that cannot answer must hand over, not guess. Every flow has
 *      `fallback_to_human`, and an unmatched reply at any node ends the bot's
 *      turn rather than repeating itself.
 *
 *   2. The bot never invents an answer about a client's filing. Where a node
 *      reports status it reads the real record; if there is no linked client,
 *      it says so and hands over.
 */

import { Db } from '../db/client.js';
import { nowIso } from '../utils/time.js';

/** Node types a flow may contain. Anything else is a broken flow. */
export const NODE_TYPES = ['message', 'question', 'status', 'handover', 'collect_document'];

/**
 * Validate a flow graph before it is stored.
 *
 * A flow with a dangling `next` is a conversation that dead-ends mid-way, and
 * the person on the other end is a client waiting for a reply. Better to
 * refuse it at the API than discover it in production.
 */
export function validateFlow({ nodes, entryNodeId }) {
  const errors = [];
  if (!Array.isArray(nodes) || !nodes.length) {
    return { valid: false, errors: ['A flow needs at least one node.'] };
  }

  const ids = new Set();
  for (const node of nodes) {
    if (!node.id) { errors.push('Every node needs an id.'); continue; }
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (!NODE_TYPES.includes(node.type)) {
      errors.push(`Node ${node.id} has an unknown type "${node.type}". Allowed: ${NODE_TYPES.join(', ')}.`);
    }
    if (node.type !== 'handover' && !node.prompt) {
      errors.push(`Node ${node.id} has nothing to say.`);
    }
  }

  if (!entryNodeId) errors.push('A flow needs an entry node.');
  else if (!ids.has(entryNodeId)) errors.push(`The entry node "${entryNodeId}" is not in the flow.`);

  // Every jump must land somewhere.
  for (const node of nodes) {
    const targets = [
      node.next,
      ...(node.options ?? []).map(o => o.next),
    ].filter(Boolean);
    for (const target of targets) {
      if (!ids.has(target)) errors.push(`Node ${node.id} points at "${target}", which does not exist.`);
    }
  }

  return { valid: !errors.length, errors };
}

/**
 * Pick the flow whose trigger keywords match an inbound message.
 *
 * Longest keyword first, so "filing status" beats "status" when both are
 * registered — the more specific flow is nearly always the intended one.
 */
export async function matchFlow(db, tenantId, text) {
  const body = String(text ?? '').toLowerCase().trim();
  if (!body) return null;

  const flows = await db.many(
    'SELECT * FROM chatbot_flows WHERE tenant_id = ? AND is_active = 1', [tenantId]);

  let best = null;
  let bestLength = 0;
  for (const flow of flows) {
    let keywords = [];
    try { keywords = JSON.parse(flow.trigger_keywords_json ?? '[]'); } catch { keywords = []; }
    for (const keyword of keywords) {
      const k = String(keyword).toLowerCase().trim();
      if (!k || !body.includes(k)) continue;
      if (k.length > bestLength) { best = flow; bestLength = k.length; }
    }
  }
  return best;
}

/**
 * Work out what the bot says next.
 *
 * Returns `{ reply, nextNodeId, handover, flowId }`. `handover: true` means
 * the bot is done and a person should take the thread — the caller decides how
 * to surface that.
 */
export async function advance(ctx, { flow, nodeId, text, thread }) {
  let nodes = [];
  try { nodes = JSON.parse(flow.nodes_json ?? '[]'); } catch { nodes = []; }

  const byId = new Map(nodes.map(n => [n.id, n]));
  const current = byId.get(nodeId ?? flow.entry_node_id);

  if (!current) {
    return { reply: null, nextNodeId: null, handover: true, flowId: flow.id };
  }

  switch (current.type) {
    case 'message':
      return {
        reply: current.prompt,
        nextNodeId: current.next ?? null,
        handover: !current.next && !!flow.fallback_to_human,
        flowId: flow.id,
      };

    case 'question': {
      // No answer yet — ask, and wait.
      if (text === null || text === undefined) {
        return { reply: renderOptions(current), nextNodeId: current.id, handover: false, flowId: flow.id };
      }
      const chosen = matchOption(current, text);
      if (!chosen) {
        // One clarification, then a person. Repeating a menu at somebody who
        // has already failed it twice is how a bot earns its reputation.
        return {
          reply: current.retryPrompt ?? null,
          nextNodeId: null,
          handover: true,
          flowId: flow.id,
        };
      }
      const next = byId.get(chosen.next);
      if (!next) return { reply: chosen.reply ?? null, nextNodeId: null, handover: true, flowId: flow.id };
      return advance(ctx, { flow, nodeId: next.id, text: null, thread });
    }

    case 'status': {
      const reply = await filingStatusReply(ctx, thread);
      return {
        reply,
        nextNodeId: current.next ?? null,
        handover: !reply || !current.next,
        flowId: flow.id,
      };
    }

    case 'collect_document':
      return {
        reply: current.prompt,
        nextNodeId: current.next ?? null,
        // A document arriving needs a person to file it against the right
        // period, so this always hands over once asked.
        handover: true,
        flowId: flow.id,
      };

    case 'handover':
    default:
      return { reply: current.prompt ?? null, nextNodeId: null, handover: true, flowId: flow.id };
  }
}

function renderOptions(node) {
  if (!node.options?.length) return node.prompt;
  const lines = node.options.map((o, i) => `${i + 1}. ${o.label}`);
  return `${node.prompt}\n\n${lines.join('\n')}`;
}

/** Match by number ("2"), by exact label, or by a keyword on the option. */
function matchOption(node, text) {
  const body = String(text).toLowerCase().trim();
  if (!node.options?.length) return null;

  const index = Number.parseInt(body, 10);
  if (Number.isInteger(index) && index >= 1 && index <= node.options.length) {
    return node.options[index - 1];
  }
  return node.options.find(o =>
    String(o.label).toLowerCase().trim() === body
    || (o.keywords ?? []).some(k => body.includes(String(k).toLowerCase()))) ?? null;
}

/**
 * The real filing status for the client on this thread.
 *
 * Returns null when the thread is not linked to a client — the caller then
 * hands over rather than answering a question about a record it cannot find.
 */
async function filingStatusReply(ctx, thread) {
  if (!thread?.client_id) return null;

  const db = new Db(ctx.env.DB);
  const period = await db.one(
    `SELECT period_key, status, due_date, documents_expected, documents_verified
       FROM filing_periods
      WHERE tenant_id = ? AND client_id = ?
      ORDER BY period_key DESC LIMIT 1`,
    [thread.tenant_id, thread.client_id]);

  if (!period) return null;

  const status = String(period.status ?? '').replace(/_/g, ' ');
  const expected = Number(period.documents_expected) || 0;
  const verified = Number(period.documents_verified) || 0;

  const parts = [`Your ${period.period_key} filing is ${status}.`];
  if (expected) parts.push(`${verified} of ${expected} documents are verified.`);
  if (period.due_date) parts.push(`It is due on ${period.due_date}.`);
  return parts.join(' ');
}

/**
 * Run the bot for one inbound message.
 *
 * Returns null when no flow applies — the message is then simply an inbound
 * message for a person to read, which is the normal case.
 */
export async function replyToInbound(ctx, scope, { thread, text }) {
  const db = new Db(ctx.env.DB);

  // A thread a person has already taken over is not the bot's to answer.
  if (thread.assigned_to || thread.bot_handed_over) return null;

  const flow = thread.bot_flow_id
    ? await db.one('SELECT * FROM chatbot_flows WHERE id = ? AND tenant_id = ? AND is_active = 1',
        [thread.bot_flow_id, thread.tenant_id])
    : await matchFlow(db, thread.tenant_id, text);

  if (!flow) return null;

  const result = await advance(ctx, {
    flow,
    nodeId: thread.bot_flow_id ? thread.bot_node_id : flow.entry_node_id,
    text: thread.bot_flow_id ? text : null,
    thread,
  });

  await scope.update('chat_threads', thread.id, {
    bot_flow_id: result.handover ? null : result.flowId,
    bot_node_id: result.handover ? null : result.nextNodeId,
    bot_handed_over: result.handover ? 1 : 0,
    updated_at: nowIso(),
  });

  return result;
}
