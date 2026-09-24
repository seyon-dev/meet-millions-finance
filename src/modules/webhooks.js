/**
 * Inbound webhooks.
 *
 * Mounted outside /api because these requests carry no session — the
 * signature is the authentication. Three rules hold for every source here:
 *
 *   1. The raw body is read once and verified before it is parsed. A payload
 *      that fails its signature never reaches business logic.
 *   2. Every delivery is recorded in webhook_events with its signature status,
 *      so a rejected one is visible rather than silently dropped.
 *   3. Delivery is at-least-once, so every handler is idempotent: a repeated
 *      event id is marked `duplicate` and changes nothing.
 *
 * A source with no configured secret is `missing_secret`, and the event is
 * stored but not acted on. Trusting an unverifiable payment notification is
 * how a system pays out on a forged message.
 */

import { createRouter } from '../http/router.js';
import { json } from '../http/response.js';
import { Db } from '../db/client.js';
import { TenantScope } from '../db/tenancy.js';
import { ID } from '../utils/id.js';
import { nowIso, addHours } from '../utils/time.js';
import { paymentProvider } from '../integrations/payments.js';
import { telephonyProvider } from '../integrations/telephony.js';
import { WhatsAppProvider } from '../integrations/messaging.js';
import { MetaLeadsProvider, DigioProvider, LeegalityProvider } from '../integrations/workspace.js';
import { settlePayment } from './billing.js';
import { logSystemEvent } from '../services/logging.js';
import { auditSystem } from '../services/audit.js';
import { replyToInbound } from '../services/chatbot.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
router.post('/payments/:gateway', async (ctx) => {
  const gateway = ctx.params.gateway;
  const provider = paymentProvider(gateway, ctx.env);
  if (!provider) return receipt({ source: gateway, status: 'ignored', reason: 'unknown_gateway' });

  const raw = await ctx.rawBody();
  const signature = ctx.header('x-razorpay-signature')
    ?? ctx.header('stripe-signature')
    ?? ctx.header('x-webhook-signature')
    ?? ctx.header('x-verify');

  const verified = await provider.verifyWebhook(raw, signature, ctx.header('x-webhook-timestamp'));
  const payload = safeParse(raw);
  const eventId = payload?.id ?? payload?.event_id ?? payload?.data?.id ?? null;
  const eventType = payload?.event ?? payload?.type ?? payload?.data?.type ?? null;

  const record = await store(ctx, {
    source: gateway,
    eventId,
    eventType,
    signatureStatus: signatureStatus(verified),
    raw,
  });
  if (record.duplicate) return receipt({ source: gateway, status: 'duplicate', id: record.id });

  if (!verified.valid) {
    await finish(ctx, record.id, 'failed',
      verified.reason === 'missing_secret'
        ? `No webhook secret is configured for ${gateway}; the event was stored but not applied.`
        : 'Signature verification failed.');
    // 200 either way: a gateway that receives a 4xx will retry the same
    // unverifiable payload for hours. The event is on record for an operator.
    return receipt({ source: gateway, status: 'rejected', reason: verified.reason ?? 'invalid_signature' });
  }

  const outcome = await applyPaymentEvent(ctx, gateway, payload, eventType);
  await finish(ctx, record.id, outcome.status, outcome.message);
  return receipt({ source: gateway, status: outcome.status, id: record.id });
}, { auth: false, rateLimit: 'webhook' });

/**
 * Act on a verified gateway event.
 *
 * The payment row is found by the gateway's own order or payment id, never by
 * anything the payload asserts about amounts or tenancy — a verified message
 * still only tells us *which* payment it concerns, not what it is worth.
 */
async function applyPaymentEvent(ctx, gateway, payload, eventType) {
  const entity = payload?.payload?.payment?.entity ?? payload?.data?.object ?? payload?.data ?? payload;
  const orderId = entity?.order_id ?? entity?.order_token ?? entity?.merchantTransactionId ?? null;
  const gatewayPaymentId = entity?.id ?? entity?.payment_id ?? entity?.transactionId ?? null;

  if (!orderId && !gatewayPaymentId) {
    return { status: 'ignored', message: 'The event carried no order or payment reference.' };
  }

  const db = new Db(ctx.env.DB);
  const payment = await db.one(
    `SELECT * FROM payments
      WHERE (gateway_order_id = ? OR gateway_payment_id = ?) AND gateway = ?
      ORDER BY created_at DESC LIMIT 1`,
    [orderId, gatewayPaymentId, gateway]);

  if (!payment) {
    return { status: 'ignored', message: `No payment matches ${orderId ?? gatewayPaymentId}.` };
  }
  if (payment.status === 'success') {
    return { status: 'duplicate', message: 'That payment was already settled.' };
  }

  const scope = new TenantScope(db, payment.tenant_id);
  const systemCtx = webhookCtx(ctx, payment.tenant_id, gateway);

  const failed = /fail|cancel|expire|declin/i.test(String(eventType ?? entity?.status ?? ''));
  if (failed) {
    await scope.update('payments', payment.id, {
      status: 'failed',
      failure_code: entity?.error_code ?? 'gateway_reported_failure',
      failure_reason: entity?.error_description ?? entity?.error_reason ?? `Gateway reported ${eventType}.`,
    });
    await auditSystem(ctx.env, {
      tenantId: payment.tenant_id, action: 'payments.failed', category: 'payments',
      severity: 'warning', entityType: 'payment', entityId: payment.id,
      entityLabel: payment.reference_no, source: `webhook:${gateway}`,
      newValue: { eventType, code: entity?.error_code ?? null },
    });
    return { status: 'processed', message: `Payment ${payment.reference_no} marked failed.` };
  }

  const captured = /captur|success|paid|complet/i.test(String(eventType ?? entity?.status ?? ''));
  if (!captured) {
    return { status: 'ignored', message: `Nothing to do for ${eventType ?? 'this event'}.` };
  }

  // The gateway is the authority on what was actually captured, so an amount
  // that disagrees with the payment is a flag, not something to paper over.
  const reported = Number(entity?.amount ?? entity?.amount_paid ?? 0);
  if (reported && reported !== payment.amount_paise) {
    await scope.update('payments', payment.id, {
      status: 'disputed',
      failure_code: 'amount_mismatch',
      failure_reason: `Gateway captured ${reported} paise against an expected ${payment.amount_paise}.`,
    });
    await auditSystem(ctx.env, {
      tenantId: payment.tenant_id, action: 'payments.failed', category: 'payments',
      severity: 'critical', entityType: 'payment', entityId: payment.id,
      entityLabel: payment.reference_no, source: `webhook:${gateway}`,
      newValue: { expectedPaise: payment.amount_paise, reportedPaise: reported },
    });
    return { status: 'failed', message: 'Captured amount does not match the payment.' };
  }

  await settlePayment(systemCtx, scope, payment, {
    gatewayPaymentId: gatewayPaymentId ?? payment.gateway_payment_id,
    method: entity?.method ?? null,
    signature: null,
  });

  await auditSystem(ctx.env, {
    tenantId: payment.tenant_id, action: 'payments.succeeded', category: 'payments',
    entityType: 'payment', entityId: payment.id, entityLabel: payment.reference_no,
    source: `webhook:${gateway}`,
    newValue: { gatewayPaymentId, amountPaise: payment.amount_paise, eventType },
  });

  return { status: 'processed', message: `Payment ${payment.reference_no} settled.` };
}

// ---------------------------------------------------------------------------
// Telephony
// ---------------------------------------------------------------------------
router.post('/telephony/:provider', async (ctx) => {
  const key = ctx.params.provider;
  const provider = telephonyProvider(key, ctx.env);
  if (!provider) return receipt({ source: key, status: 'ignored', reason: 'unknown_provider' });

  const raw = await ctx.rawBody();
  const signature = ctx.header('x-twilio-signature')
    ?? ctx.header('x-plivo-signature-v2')
    ?? ctx.header('x-exotel-signature')
    ?? ctx.header('authorization');

  const verified = await provider.verifyWebhook(raw, signature, ctx.url.toString());
  const payload = parseFormOrJson(raw, ctx.header('content-type'));
  const providerCallId = payload?.CallSid ?? payload?.CallUuid ?? payload?.call_sid
    ?? payload?.CallId ?? payload?.uuid ?? null;

  const record = await store(ctx, {
    source: key,
    eventId: providerCallId ? `${providerCallId}:${payload?.CallStatus ?? payload?.Status ?? 'event'}` : null,
    eventType: payload?.CallStatus ?? payload?.Status ?? payload?.event ?? null,
    signatureStatus: signatureStatus(verified),
    raw,
  });
  if (record.duplicate) return receipt({ source: key, status: 'duplicate', id: record.id });

  if (!verified.valid) {
    await finish(ctx, record.id, 'failed', `Signature ${verified.reason ?? 'invalid'}.`);
    return receipt({ source: key, status: 'rejected', reason: verified.reason ?? 'invalid_signature' });
  }

  const outcome = await applyTelephonyEvent(ctx, key, payload, providerCallId);
  await finish(ctx, record.id, outcome.status, outcome.message);
  return receipt({ source: key, status: outcome.status, id: record.id });
}, { auth: false, rateLimit: 'webhook' });

async function applyTelephonyEvent(ctx, providerKey, payload, providerCallId) {
  if (!providerCallId) return { status: 'ignored', message: 'No call identifier in the payload.' };

  const db = new Db(ctx.env.DB);
  const call = await db.one(
    'SELECT * FROM call_records WHERE provider_call_id = ? ORDER BY created_at DESC LIMIT 1',
    [providerCallId]);

  // An unmatched inbound call is the normal case for a first ring: create it
  // so the incoming-call popup has something to show.
  if (!call) return createInboundCall(ctx, db, providerKey, payload, providerCallId);

  const scope = new TenantScope(db, call.tenant_id);
  const status = normaliseCallStatus(payload?.CallStatus ?? payload?.Status ?? payload?.event);
  const duration = Number(payload?.CallDuration ?? payload?.Duration ?? payload?.duration ?? 0) || 0;
  const ended = ['completed', 'missed', 'busy', 'no_answer', 'failed', 'cancelled'].includes(status);

  await scope.update('call_records', call.id, {
    status,
    answered: (status === 'completed' || status === 'in_progress') ? 1 : call.answered,
    answered_at: call.answered_at ?? (status === 'in_progress' ? nowIso() : null),
    ended_at: ended ? nowIso() : call.ended_at,
    duration_seconds: duration || call.duration_seconds,
    talk_seconds: duration || call.talk_seconds,
  });

  const recordingUrl = payload?.RecordingUrl ?? payload?.recording_url ?? payload?.RecordingUrl0 ?? null;
  if (recordingUrl) {
    const existing = await scope.first('call_recordings', { call_id: call.id });
    if (!existing) {
      // The URL is stored, not the bytes: fetching provider audio needs the
      // provider's credentials and belongs in the recording ingest path.
      await scope.insert('call_recordings', {
        id: ID.recording(), call_id: call.id, provider_url: recordingUrl,
        duration_seconds: duration, status: 'pending',
      });
    }
  }

  return { status: 'processed', message: `Call ${call.id} updated to ${status}.` };
}

async function createInboundCall(ctx, db, providerKey, payload, providerCallId) {
  const to = payload?.To ?? payload?.called_number ?? payload?.to ?? null;
  const from = payload?.From ?? payload?.caller_id ?? payload?.from ?? null;
  if (!to) return { status: 'ignored', message: 'No destination number to match an organisation on.' };

  // The virtual number is what ties an inbound call to a tenant.
  const settings = await db.one(
    `SELECT * FROM telephony_settings
      WHERE caller_id = ? OR virtual_numbers_json LIKE ? LIMIT 1`,
    [to, `%${to}%`]);
  if (!settings) {
    return { status: 'ignored', message: `No organisation claims the number ${to}.` };
  }

  const scope = new TenantScope(db, settings.tenant_id);
  const digits = String(from ?? '').replace(/\D/g, '').slice(-10);
  const client = digits
    ? await db.one(
        `SELECT c.id, c.company_id FROM clients c
           LEFT JOIN client_contacts cc ON cc.client_id = c.id
          WHERE c.tenant_id = ? AND (
                REPLACE(COALESCE(c.phone,''), ' ', '') LIKE ?
             OR REPLACE(COALESCE(cc.phone,''), ' ', '') LIKE ?)
          LIMIT 1`, [settings.tenant_id, `%${digits}`, `%${digits}`])
    : null;

  const call = await scope.insert('call_records', {
    id: ID.call(),
    client_id: client?.id ?? null,
    company_id: client?.company_id ?? null,
    provider: providerKey,
    provider_call_id: providerCallId,
    direction: 'inbound',
    from_number: from ?? 'unknown',
    to_number: to,
    virtual_number: to,
    status: normaliseCallStatus(payload?.CallStatus ?? payload?.Status ?? 'ringing'),
    recording_enabled: settings.recording_mode === 'disabled' ? 0 : 1,
    started_at: nowIso(),
  });

  return { status: 'processed', message: `Inbound call ${call.id} recorded.` };
}

// ---------------------------------------------------------------------------
// WhatsApp — Meta sends a GET to verify the endpoint, then POSTs messages
// ---------------------------------------------------------------------------
router.get('/whatsapp', async (ctx) => {
  const expected = ctx.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected) return new Response('Not configured', { status: 503 });

  const challenge = ctx.q('hub.challenge');
  if (ctx.q('hub.mode') === 'subscribe' && ctx.q('hub.verify_token') === expected && challenge) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}, { auth: false });

router.post('/whatsapp', async (ctx) => {
  const raw = await ctx.rawBody();
  const provider = new WhatsAppProvider(ctx.env);
  const verified = await provider.verifyWebhook(raw, ctx.header('x-hub-signature-256'));
  const payload = safeParse(raw);

  const change = payload?.entry?.[0]?.changes?.[0]?.value ?? null;
  const message = change?.messages?.[0] ?? null;
  const statusUpdate = change?.statuses?.[0] ?? null;

  const record = await store(ctx, {
    source: 'whatsapp',
    eventId: message?.id ?? (statusUpdate ? `${statusUpdate.id}:${statusUpdate.status}` : null),
    eventType: message ? 'message' : (statusUpdate ? `status:${statusUpdate.status}` : 'unknown'),
    signatureStatus: signatureStatus(verified),
    raw,
  });
  if (record.duplicate) return receipt({ source: 'whatsapp', status: 'duplicate', id: record.id });

  if (!verified.valid) {
    await finish(ctx, record.id, 'failed', `Signature ${verified.reason ?? 'invalid'}.`);
    return receipt({ source: 'whatsapp', status: 'rejected', reason: verified.reason ?? 'invalid_signature' });
  }

  const db = new Db(ctx.env.DB);
  let outcome = { status: 'ignored', message: 'Nothing actionable in this event.' };

  if (statusUpdate) {
    const changes = await db.run(
      `UPDATE message_deliveries SET status = ?, updated_at = ? WHERE provider_message_id = ?`,
      [mapWhatsAppStatus(statusUpdate.status), nowIso(), statusUpdate.id]);
    outcome = changes?.changes
      ? { status: 'processed', message: `Delivery ${statusUpdate.id} is ${statusUpdate.status}.` }
      : { status: 'ignored', message: 'No delivery matches that message id.' };
  } else if (message) {
    outcome = await storeInboundWhatsApp(db, change, message);
  }

  await finish(ctx, record.id, outcome.status, outcome.message);
  return receipt({ source: 'whatsapp', status: outcome.status, id: record.id });
}, { auth: false, rateLimit: 'webhook' });

/** Every scalar value in an integration's stored config, for exact matching. */
function configValues(json) {
  const out = new Set();
  try {
    const walk = (v) => {
      if (v === null || v === undefined) return;
      if (typeof v === 'object') { Object.values(v).forEach(walk); return; }
      out.add(String(v));
    };
    walk(JSON.parse(json ?? '{}'));
  } catch { /* an unparseable config matches nothing */ }
  return out;
}

async function storeInboundWhatsApp(db, change, message) {
  const businessNumber = change?.metadata?.display_phone_number
    ?? change?.metadata?.phone_number_id ?? null;
  // An inbound message is only ever attributed to the organisation whose
  // integration config names the receiving business number, by exact value.
  // No number, or no match, means the event is dropped — guessing would
  // deliver one organisation's messages into another's inbox.
  if (!businessNumber) {
    return { status: 'ignored', message: 'The event does not name a receiving business number.' };
  }
  const candidates = await db.many(
    "SELECT tenant_id, config_json FROM integrations WHERE provider = 'whatsapp' AND status = 'connected'");
  const integration = candidates.find(c => configValues(c.config_json).has(String(businessNumber))) ?? null;
  if (!integration) {
    return { status: 'ignored', message: 'No organisation is connected to that WhatsApp number.' };
  }

  const scope = new TenantScope(db, integration.tenant_id);
  const from = String(message.from ?? '').replace(/\D/g, '');
  const digits = from.slice(-10);

  const client = digits
    ? await db.one(
        `SELECT c.id FROM clients c LEFT JOIN client_contacts cc ON cc.client_id = c.id
          WHERE c.tenant_id = ? AND (REPLACE(COALESCE(c.phone,''),' ','') LIKE ?
             OR REPLACE(COALESCE(cc.phone,''),' ','') LIKE ?) LIMIT 1`,
        [integration.tenant_id, `%${digits}`, `%${digits}`])
    : null;

  let thread = await db.one(
    "SELECT * FROM chat_threads WHERE tenant_id = ? AND channel = 'whatsapp' AND phone = ? LIMIT 1",
    [integration.tenant_id, from]);
  if (!thread) {
    thread = await scope.insert('chat_threads', {
      id: ID.thread(),
      channel: 'whatsapp',
      client_id: client?.id ?? null,
      phone: from,
      display_name: client ? null : `WhatsApp ${message.from}`,
      status: 'open',
      unread_count: 0,
      last_message_at: nowIso(),
    });
  }

  const body = message.text?.body ?? message.button?.text ?? `[${message.type}]`;
  await scope.insert('chat_messages', {
    id: ID.message(),
    thread_id: thread.id,
    direction: 'inbound',
    type: message.type ?? 'text',
    body,
    provider_message_id: message.id,
    status: 'delivered',
  });
  await scope.update('chat_threads', thread.id, {
    last_message_at: nowIso(),
    last_message_preview: body.slice(0, 160),
    unread_count: (thread.unread_count ?? 0) + 1,
    status: 'open',
    // Meta only allows a free-form reply within 24 hours of the last inbound
    // message; after that only an approved template may be sent. Recording the
    // deadline is what lets the inbox say which of the two is available.
    window_expires_at: addHours(24),
  });

  // ---- The chatbot ---------------------------------------------------------
  // Only text is offered to a flow: a bot cannot sensibly answer an image or a
  // document, and pretending otherwise is how a client gets a menu in reply to
  // a bank statement. Anything else simply waits for a person.
  let bot = null;
  if ((message.type ?? 'text') === 'text') {
    const current = await scope.first('chat_threads', { id: thread.id });
    try {
      bot = await replyToInbound(ctx, scope, { thread: current, text: body });
    } catch (err) {
      // A broken flow must never swallow a client's message. The message is
      // already stored; log the failure and leave the thread to a person.
      bot = null;
      await logSystemEvent(ctx.env, {
        level: 'error', source: 'webhook', event: 'chatbot_failed',
        message: err?.message ?? 'Chatbot flow failed', stack: err?.stack,
        tenantId: integration.tenant_id, context: { threadId: thread.id },
      });
    }
  }

  if (bot?.reply) {
    const provider = new WhatsAppProvider(ctx.env);
    const sent = await provider.sendText({ to: from, text: bot.reply });

    await scope.insert('chat_messages', {
      id: ID.message(),
      thread_id: thread.id,
      direction: 'outbound',
      type: 'text',
      body: bot.reply,
      provider_message_id: sent?.data?.messageId ?? null,
      // Reported as what actually happened, not as a hopeful 'sent'.
      status: sent?.ok ? 'sent' : 'failed',
      sent_by: null,
    });
    await scope.update('chat_threads', thread.id, {
      last_message_at: nowIso(),
      last_message_preview: bot.reply.slice(0, 160),
      status: bot.handover ? 'open' : 'bot',
    });
  }

  return {
    status: 'processed',
    message: bot?.reply
      ? `Message from ${message.from} answered by a chatbot flow.`
      : `Message from ${message.from} stored.`,
  };
}

function mapWhatsAppStatus(status) {
  return { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' }[status] ?? 'sent';
}

// ---------------------------------------------------------------------------
// Meta Lead Ads
// ---------------------------------------------------------------------------
router.get('/meta-leads', async (ctx) => {
  // The name must match the one the provider and .env.example use. It read
  // META_VERIFY_TOKEN here and META_LEADGEN_VERIFY_TOKEN everywhere else, so
  // the value was always undefined and Meta's subscription handshake got a
  // 503 no matter how the deployment was configured.
  const expected = ctx.env.META_LEADGEN_VERIFY_TOKEN;
  if (!expected) return new Response('Not configured', { status: 503 });
  if (ctx.q('hub.mode') === 'subscribe' && ctx.q('hub.verify_token') === expected) {
    return new Response(ctx.q('hub.challenge') ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}, { auth: false });

router.post('/meta-leads', async (ctx) => {
  const raw = await ctx.rawBody();
  const provider = new MetaLeadsProvider(ctx.env);
  const verified = await provider.verifyWebhook(raw, ctx.header('x-hub-signature-256'));
  const payload = safeParse(raw);
  const change = payload?.entry?.[0]?.changes?.[0]?.value ?? null;

  const record = await store(ctx, {
    source: 'meta',
    eventId: change?.leadgen_id ?? null,
    eventType: 'leadgen',
    signatureStatus: signatureStatus(verified),
    raw,
  });
  if (record.duplicate) return receipt({ source: 'meta', status: 'duplicate', id: record.id });

  if (!verified.valid) {
    await finish(ctx, record.id, 'failed', `Signature ${verified.reason ?? 'invalid'}.`);
    return receipt({ source: 'meta', status: 'rejected', reason: verified.reason ?? 'invalid_signature' });
  }

  // Meta sends only an id; the lead's fields need a credentialed fetch. That
  // is the sync job's work, so the event is queued rather than half-applied.
  const db = new Db(ctx.env.DB);
  const candidates = await db.many(
    "SELECT tenant_id, config_json FROM integrations WHERE provider = 'meta_leads' AND status = 'connected'");
  const pageId = change?.page_id ?? null;
  const integration = candidates.find(c => !pageId
    || String(c.config_json ?? '').includes(String(pageId))) ?? candidates[0] ?? null;

  if (integration) {
    const scope = new TenantScope(db, integration.tenant_id);
    await scope.insert('integration_sync_logs', {
      id: ID.syncLog(),
      provider: 'meta_leads',
      direction: 'inbound',
      operation: 'leadgen_webhook',
      status: 'queued',
      records_in: 1,
      detail_json: JSON.stringify({
        leadgenId: change?.leadgen_id, formId: change?.form_id, pageId: change?.page_id,
      }),
      started_at: nowIso(),
    });
  }

  const outcome = integration
    ? { status: 'processed', message: `Lead ${change?.leadgen_id} queued for retrieval.` }
    : { status: 'ignored', message: 'No organisation is connected to that page.' };

  await finish(ctx, record.id, outcome.status, outcome.message);
  return receipt({ source: 'meta', status: outcome.status, id: record.id });
}, { auth: false, rateLimit: 'webhook' });

// ---------------------------------------------------------------------------
// e-Sign callbacks
// ---------------------------------------------------------------------------
router.post('/esign/:provider', async (ctx) => {
  const key = ctx.params.provider;
  const Provider = { digio: DigioProvider, leegality: LeegalityProvider }[key];
  if (!Provider) return receipt({ source: key, status: 'ignored', reason: 'unknown_provider' });

  const raw = await ctx.rawBody();
  const provider = new Provider(ctx.env);
  const verified = await provider.verifyWebhook(
    raw, ctx.header('x-digio-signature') ?? ctx.header('x-leegality-signature'));
  const payload = safeParse(raw);
  const requestId = payload?.id ?? payload?.document_id ?? payload?.documentId ?? null;

  const record = await store(ctx, {
    source: key,
    eventId: requestId ? `${requestId}:${payload?.status ?? 'event'}` : null,
    eventType: payload?.status ?? payload?.event ?? null,
    signatureStatus: signatureStatus(verified),
    raw,
  });
  if (record.duplicate) return receipt({ source: key, status: 'duplicate', id: record.id });

  if (!verified.valid) {
    await finish(ctx, record.id, 'failed', `Signature ${verified.reason ?? 'invalid'}.`);
    return receipt({ source: key, status: 'rejected', reason: verified.reason ?? 'invalid_signature' });
  }

  const db = new Db(ctx.env.DB);
  const request = requestId
    ? await db.one('SELECT * FROM esign_requests WHERE provider_request_id = ? LIMIT 1', [requestId])
    : null;

  let outcome = { status: 'ignored', message: 'No e-sign request matches that id.' };
  if (request) {
    const scope = new TenantScope(db, request.tenant_id);
    const status = normaliseEsignStatus(payload?.status ?? payload?.event);
    await scope.update('esign_requests', request.id, {
      status,
      completed_at: status === 'completed' ? nowIso() : request.completed_at,
    });
    const signerEmail = payload?.signer_identifier ?? payload?.signerEmail ?? null;
    if (signerEmail) {
      await scope.updateWhere('esign_signers',
        { request_id: request.id, email: signerEmail },
        { status: status === 'completed' ? 'signed' : status, signed_at: nowIso() });
    }
    outcome = { status: 'processed', message: `e-Sign request ${request.id} is ${status}.` };
  }

  await finish(ctx, record.id, outcome.status, outcome.message);
  return receipt({ source: key, status: outcome.status, id: record.id });
}, { auth: false, rateLimit: 'webhook' });

// ---------------------------------------------------------------------------
// Website contact forms — a per-endpoint token, not a shared secret
// ---------------------------------------------------------------------------
router.post('/forms/:endpointKey', async (ctx) => {
  const raw = await ctx.rawBody();
  const db = new Db(ctx.env.DB);
  const endpoint = await db.one(
    'SELECT * FROM webhook_endpoints WHERE slug = ? AND is_active = 1 LIMIT 1',
    [ctx.params.endpointKey]);

  const record = await store(ctx, {
    source: 'website_form',
    eventId: null,
    eventType: 'submission',
    signatureStatus: endpoint ? 'valid' : 'invalid',
    raw,
    tenantId: endpoint?.tenant_id ?? null,
  });

  if (!endpoint) {
    await finish(ctx, record.id, 'failed', 'Unknown form endpoint.');
    return receipt({ source: 'website_form', status: 'rejected', reason: 'unknown_endpoint' });
  }

  const payload = parseFormOrJson(raw, ctx.header('content-type')) ?? {};
  const scope = new TenantScope(db, endpoint.tenant_id);

  const lead = await scope.insert('leads', {
    id: ID.lead(),
    source: 'website_form',
    external_id: endpoint.id,
    full_name: cleanField(payload.name ?? payload.full_name ?? payload.fullName) ?? 'Website enquiry',
    email: cleanField(payload.email),
    phone: cleanField(payload.phone ?? payload.mobile),
    company_name: cleanField(payload.company ?? payload.organisation),
    city: cleanField(payload.city, 80),
    message: cleanField(payload.message ?? payload.enquiry ?? payload.comments, 2000),
    status: 'new',
    utm_source: cleanField(payload.utm_source, 80),
    utm_medium: cleanField(payload.utm_medium, 80),
    utm_campaign: cleanField(payload.utm_campaign, 80),
    page_url: cleanField(payload.page_url ?? payload.pageUrl, 500),
    payload_json: JSON.stringify(payload).slice(0, 8000),
  });

  await scope.update('webhook_endpoints', endpoint.id, {
    request_count: (endpoint.request_count ?? 0) + 1,
    last_request_at: nowIso(),
  });

  await finish(ctx, record.id, 'processed', `Lead ${lead.id} captured.`);
  return receipt({ source: 'website_form', status: 'processed', id: record.id });
}, { auth: false, rateLimit: 'webhook' });

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * A context standing in for the gateway, for code that expects a request.
 *
 * It satisfies the same shape a real RequestContext does — including defer(),
 * which settlement uses for its receipt work — while making it plain in every
 * audit row and log line that no person took this action.
 */
function webhookCtx(ctx, tenantId, source) {
  return {
    env: ctx.env,
    tenantId,
    userId: null,
    user: null,
    tenant: null,
    roleKeys: ['system'],
    permissions: new Set(['*']),
    has: () => true,
    hasRole: () => false,
    ip: `webhook:${source}`,
    userAgent: `meet-millions-webhook/${source}`,
    session: null,
    apiKey: null,
    requestId: ctx.requestId,
    // Inline rather than deferred: a webhook response is not returned to a
    // person waiting on it, and the isolate may be reclaimed immediately.
    defer: (p) => (typeof p === 'function' ? p() : p),
  };
}

/** Record the delivery, and report whether this exact event was seen before. */
async function store(ctx, { source, eventId, eventType, signatureStatus: sig, raw, tenantId = null }) {
  const db = new Db(ctx.env.DB);

  if (eventId) {
    const seen = await db.one(
      'SELECT id FROM webhook_events WHERE source = ? AND event_id = ? LIMIT 1', [source, eventId]);
    if (seen) {
      await db.run(
        "UPDATE webhook_events SET status = 'duplicate', processed_at = ? WHERE id = ?",
        [nowIso(), seen.id]);
      return { id: seen.id, duplicate: true };
    }
  }

  const id = ID.webhookEvent();
  await db.insert('webhook_events', {
    id,
    tenant_id: tenantId,
    source,
    event_id: eventId,
    event_type: eventType,
    signature_status: sig,
    status: 'received',
    // Bounded: a malformed or hostile payload must not be able to fill D1.
    payload_json: String(raw ?? '').slice(0, 64 * 1024),
    headers_json: JSON.stringify(safeHeaders(ctx)),
    received_at: nowIso(),
  });
  return { id, duplicate: false };
}

async function finish(ctx, id, status, message) {
  const db = new Db(ctx.env.DB);
  const mapped = ['received', 'processed', 'ignored', 'failed', 'duplicate'].includes(status)
    ? status : 'ignored';
  await db.run(
    'UPDATE webhook_events SET status = ?, error_message = ?, processed_at = ? WHERE id = ?',
    [mapped, mapped === 'failed' ? message : null, nowIso(), id]);

  if (mapped === 'failed') {
    await logSystemEvent(ctx.env, {
      level: 'warn', source: 'webhook', event: 'webhook_rejected',
      message, path: ctx.pathname, requestId: ctx.requestId,
    });
  }
}

/**
 * Webhooks always get a 200 with a machine-readable body.
 *
 * A non-2xx makes the sender retry, and retrying an event we have already
 * decided about — a forged signature, an unknown gateway — achieves nothing
 * but noise. The body says what happened, and webhook_events holds the detail.
 */
function receipt(body) {
  return json({ received: true, ...body });
}

function signatureStatus(verified) {
  if (verified?.valid) return 'valid';
  if (verified?.reason === 'missing_secret') return 'missing_secret';
  return 'invalid';
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function parseFormOrJson(raw, contentType = '') {
  if (String(contentType).includes('json')) return safeParse(raw);
  try {
    const params = new URLSearchParams(raw);
    const out = {};
    for (const [k, v] of params) out[k] = v;
    return Object.keys(out).length ? out : safeParse(raw);
  } catch {
    return safeParse(raw);
  }
}

function safeHeaders(ctx) {
  // Never store an Authorization header or a signature: they are credentials,
  // and webhook_events is read by support staff.
  const keep = ['content-type', 'user-agent', 'x-forwarded-for', 'cf-connecting-ip', 'cf-ray'];
  const out = {};
  for (const name of keep) {
    const value = ctx.header(name);
    if (value) out[name] = value;
  }
  return out;
}

/** Strip control characters and bound the length of anything a stranger sent. */
function cleanField(value, max = 200) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value)
    .split('')
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .trim()
    .slice(0, max);
  return cleaned || null;
}

function normaliseCallStatus(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (['completed', 'complete', 'ended'].includes(v)) return 'completed';
  if (['in-progress', 'in_progress', 'answered', 'live'].includes(v)) return 'in_progress';
  if (['ringing', 'initiated', 'queued'].includes(v)) return 'ringing';
  if (v === 'busy') return 'busy';
  if (['no-answer', 'no_answer', 'noanswer'].includes(v)) return 'no_answer';
  if (['canceled', 'cancelled'].includes(v)) return 'cancelled';
  if (v === 'failed') return 'failed';
  if (v === 'missed') return 'missed';
  if (v === 'voicemail') return 'voicemail';
  return 'ringing';
}

function normaliseEsignStatus(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (['completed', 'signed', 'success'].includes(v)) return 'completed';
  if (['declined', 'rejected'].includes(v)) return 'declined';
  if (v === 'expired') return 'expired';
  if (['failed', 'error'].includes(v)) return 'failed';
  return 'sent';
}

export { router as webhooksRouter };
