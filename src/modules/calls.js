/**
 * The Cloud Calling & Call Recording module.
 *
 * Implements every capability the addendum's feature table lists:
 *
 *   Core calling  — dial pad, click-to-call, incoming popup, outgoing calls,
 *                   transfer, conference, IVR, voicemail
 *   Recording     — automatic, manual toggle, search, download, in-CRM playback
 *   Logging       — history, logs, timeline, notes, tags, disposition, missed
 *   Automation    — follow-up reminder, auto task after call, live call status
 *   AI            — summary, transcription, sentiment
 *   Analytics     — call analytics, duration, employee performance, reports
 *
 * Provider specifics live entirely in `integrations/telephony.js`; this module
 * talks only to the TelephonyProvider contract.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated, fileResponse } from '../http/response.js';
import {
  BadRequestError, ConflictError, ForbiddenError, IntegrationError, NotFoundError,
} from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate, toE164 } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, dayKey, monthKey, addHours, addDays, secondsBetween, recentMonthKeys } from '../utils/time.js';
import { audit, auditAsync, recordActivity } from '../services/audit.js';
import { assertFeature, hasFeature, bumpUsage } from '../services/features.js';
import { dispatchNotification } from '../services/notifications.js';
import { telephonyProvider, describeTelephonyProviders, CALL_STATUS } from '../integrations/telephony.js';
import { SpeechProvider } from '../integrations/ai.js';
import { analyseCall } from '../services/ai.js';
import { putObject, getObject, recordingKey, signDownloadUrl } from '../services/storage.js';
import { CALLING_FEATURE_GROUPS, TELEPHONY_PROVIDERS } from '../data/addons.js';
import { loadClientIdsForUser } from '../auth/identity.js';

const router = createRouter();
const LIVE_STATUSES = ['initiated', 'ringing', 'in_progress', 'on_hold'];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
router.get('/settings', async (ctx) => {
  const scope = scopeFor(ctx);
  const settings = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  const dispositions = await scope.all('call_dispositions', { is_active: 1 }, { order: 'sort_order ASC' });
  const tags = await scope.all('call_tags', {}, { order: 'usage_count DESC', limit: 50 });
  const agents = await scope.raw(
    `SELECT ta.*, u.full_name, u.email FROM telephony_agents ta
       JOIN users u ON u.id = ta.user_id
      WHERE ta.tenant_id = ? ORDER BY u.full_name`, [ctx.tenantId]);
  const ivrFlows = await scope.all('ivr_flows', {}, { order: 'created_at DESC', limit: 20 });

  const providers = describeTelephonyProviders(ctx.env);
  const active = providers.find(p => p.key === (settings?.provider ?? 'exotel'));

  return ok({
    settings: settings ? {
      provider: settings.provider,
      status: active?.configured ? 'connected' : 'not_connected',
      callerId: settings.caller_id,
      virtualNumbers: safeJson(settings.virtual_numbers_json, []),
      recordingMode: settings.recording_mode,
      recordingRetentionDays: settings.recording_retention_days,
      transcriptionEnabled: !!settings.transcription_enabled,
      aiSummaryEnabled: !!settings.ai_summary_enabled,
      sentimentEnabled: !!settings.sentiment_enabled,
      autoCreateTask: !!settings.auto_create_task,
      autoLogActivity: !!settings.auto_log_activity,
      ivrEnabled: !!settings.ivr_enabled,
      voicemailEnabled: !!settings.voicemail_enabled,
      businessHours: safeJson(settings.business_hours_json, null),
      lastTestAt: settings.last_test_at,
      lastTestOk: settings.last_test_ok === null ? null : !!settings.last_test_ok,
      lastTestMessage: settings.last_test_message,
    } : null,
    providers,
    providerCatalogue: TELEPHONY_PROVIDERS,
    capabilities: active?.capabilities ?? null,
    dispositions,
    tags,
    agents: agents.map(a => ({
      id: a.id, userId: a.user_id, name: a.full_name, email: a.email,
      extension: a.extension, directNumber: a.direct_number,
      providerAgentId: a.provider_agent_id, presence: a.presence, isActive: !!a.is_active,
    })),
    ivrFlows,
    featureGroups: CALLING_FEATURE_GROUPS,
  }, { ctx });
}, { anyPermission: ['calls.configure', 'calls.view', 'calls.view.own'] });

router.patch('/settings', async (ctx) => {
  await assertFeature(ctx, 'cloud_telephony');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    provider: { type: 'enum', values: TELEPHONY_PROVIDERS.map(p => p.key) },
    callerId: { type: 'string', max: 20 },
    virtualNumbers: { type: 'array', max: 20, of: { type: 'string', max: 20 } },
    recordingMode: { type: 'enum', values: ['automatic', 'manual', 'disabled'] },
    recordingRetentionDays: { type: 'int', min: 1, max: 2555 },
    transcriptionEnabled: { type: 'boolean' },
    aiSummaryEnabled: { type: 'boolean' },
    sentimentEnabled: { type: 'boolean' },
    autoCreateTask: { type: 'boolean' },
    autoLogActivity: { type: 'boolean' },
    ivrEnabled: { type: 'boolean' },
    voicemailEnabled: { type: 'boolean' },
    businessHours: { type: 'json' },
  });

  const existing = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  const patch = pruneNull({
    provider: input.provider,
    caller_id: input.callerId,
    virtual_numbers_json: input.virtualNumbers ? JSON.stringify(input.virtualNumbers) : undefined,
    recording_mode: input.recordingMode,
    recording_retention_days: input.recordingRetentionDays,
    transcription_enabled: boolToInt(input.transcriptionEnabled),
    ai_summary_enabled: boolToInt(input.aiSummaryEnabled),
    sentiment_enabled: boolToInt(input.sentimentEnabled),
    auto_create_task: boolToInt(input.autoCreateTask),
    auto_log_activity: boolToInt(input.autoLogActivity),
    ivr_enabled: boolToInt(input.ivrEnabled),
    voicemail_enabled: boolToInt(input.voicemailEnabled),
    business_hours_json: input.businessHours ? JSON.stringify(input.businessHours) : undefined,
    updated_by: ctx.userId,
  });

  // AI features need the Claude API; say so rather than enabling a dead switch.
  if (input.aiSummaryEnabled || input.sentimentEnabled) {
    if (!ctx.env.ANTHROPIC_API_KEY || String(ctx.env.ANTHROPIC_API_KEY).startsWith('replace-with-')) {
      throw new IntegrationError('Claude API',
        'AI call summaries and sentiment need ANTHROPIC_API_KEY configured on this deployment.',
        { configured: false });
    }
  }
  if (input.transcriptionEnabled && !ctx.env.GOOGLE_SPEECH_API_KEY) {
    throw new IntegrationError('Google Cloud Speech-to-Text',
      'Call transcription needs GOOGLE_SPEECH_API_KEY configured on this deployment.',
      { configured: false });
  }

  if (existing) {
    await scope.updateWhere('telephony_settings', { tenant_id: ctx.tenantId }, patch);
  } else {
    await scope.insert('telephony_settings', { tenant_id: ctx.tenantId, ...patch, updated_at: nowIso() });
  }

  await audit(ctx, {
    action: 'calls.settings_changed', category: 'calls', severity: 'notice',
    entityType: 'telephony_settings', entityId: ctx.tenantId,
    oldValue: existing ? pick(existing, Object.keys(patch)) : null,
    newValue: patch,
  });

  const updated = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  return ok({ settings: updated }, { ctx });
}, { permission: 'calls.configure' });

router.post('/settings/test', async (ctx) => {
  const scope = scopeFor(ctx);
  const settings = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  const provider = telephonyProvider(settings?.provider ?? 'exotel', ctx.env);
  if (!provider) throw new BadRequestError('No telephony provider is selected.');

  const result = await provider.test();
  await scope.updateWhere('telephony_settings', { tenant_id: ctx.tenantId }, {
    status: result.ok ? 'connected' : 'not_connected',
    last_test_at: nowIso(),
    last_test_ok: result.ok ? 1 : 0,
    last_test_message: result.ok ? 'Connection verified.' : (result.error?.message ?? 'Test failed.').slice(0, 500),
  });

  return ok({
    provider: provider.key,
    name: provider.name,
    ok: result.ok,
    configured: provider.isConfigured(),
    missingKeys: provider.missingKeys(),
    message: result.ok ? `${provider.name} responded successfully.` : result.error?.message,
    capabilities: provider.capabilities,
  }, { ctx });
}, { permission: 'calls.configure' });

// ---------------------------------------------------------------------------
// Placing a call — the dial pad and click-to-call
// ---------------------------------------------------------------------------
router.post('/dial', async (ctx) => {
  await assertFeature(ctx, 'cloud_telephony');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    to: { type: 'phone', required: true, label: 'Number to dial' },
    clientId: { type: 'id' },
    contactId: { type: 'id' },
    leadId: { type: 'id' },
    entityType: { type: 'string', max: 30 },
    entityId: { type: 'id' },
    record: { type: 'boolean' },
    from: { type: 'phone' },
  });

  const settings = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  const provider = telephonyProvider(settings?.provider ?? 'exotel', ctx.env);

  if (!provider?.isConfigured()) {
    throw new IntegrationError(provider?.name ?? 'Cloud telephony',
      `${provider?.name ?? 'The telephony provider'} is not connected. Missing: ${(provider?.missingKeys() ?? []).join(', ')}.`,
      { configured: false, details: { missingKeys: provider?.missingKeys() ?? [] } });
  }

  const agent = await scope.first('telephony_agents', { user_id: ctx.userId });
  const agentNumber = input.from ?? agent?.direct_number ?? ctx.user.phone;
  if (!agentNumber) {
    throw new BadRequestError('Add your own phone number to your profile, or an extension under Settings → Calling, before dialling.');
  }

  // Match the number to a client so the call lands on the right timeline.
  const matched = input.clientId
    ? await scope.first('clients', { id: input.clientId })
    : await matchClientByNumber(scope, input.to);

  const shouldRecord = input.record ?? (settings?.recording_mode !== 'disabled');

  const callId = ID.call();
  const call = await scope.insert('call_records', {
    id: callId,
    company_id: matched?.company_id ?? null,
    client_id: matched?.id ?? null,
    contact_id: input.contactId ?? null,
    lead_id: input.leadId ?? null,
    agent_id: ctx.userId,
    provider: provider.key,
    direction: 'outbound',
    from_number: agentNumber,
    to_number: input.to,
    virtual_number: settings?.caller_id ?? null,
    status: 'initiated',
    recording_enabled: shouldRecord ? 1 : 0,
    is_recording: shouldRecord && settings?.recording_mode === 'automatic' ? 1 : 0,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    started_at: nowIso(),
  });

  const result = await provider.placeCall({
    from: agentNumber,
    to: input.to,
    callerId: settings?.caller_id,
    record: shouldRecord,
    agentId: agent?.provider_agent_id,
    callbackUrl: `${ctx.env.APP_URL || ''}/webhooks/telephony/${provider.key}`,
  });

  if (!result.ok) {
    await scope.update('call_records', callId, {
      status: 'failed', ended_at: nowIso(),
    });
    await audit(ctx, {
      action: 'calls.placed', category: 'calls', result: 'failure',
      entityType: 'call', entityId: callId,
      newValue: { to: input.to, error: result.error?.message },
    });
    throw new IntegrationError(provider.name,
      result.error?.message ?? 'The call could not be placed.',
      { configured: provider.isConfigured() });
  }

  await scope.update('call_records', callId, {
    provider_call_id: result.data.providerCallId,
    status: result.data.status ?? 'ringing',
  });

  await setPresence(scope, ctx.userId, 'on_call');
  await bumpUsage(ctx, 'calls', 1);

  await audit(ctx, {
    action: 'calls.placed', category: 'calls',
    entityType: 'call', entityId: callId,
    entityLabel: matched?.display_name ?? input.to,
    newValue: { to: input.to, provider: provider.key, recording: shouldRecord, clientId: matched?.id ?? null },
  });

  const updated = await scope.first('call_records', { id: callId });
  return created({
    call: toCall(updated),
    client: matched ? { id: matched.id, displayName: matched.display_name, clientCode: matched.client_code } : null,
    provider: { key: provider.key, name: provider.name, capabilities: provider.capabilities },
  }, { ctx });
}, { permission: 'calls.place' });

/** Live status — the "Live Call Status" capability, polled by the call bar. */
router.get('/live', async (ctx) => {
  // The platform owner holds calls.view but belongs to no organisation, and
  // calls belong to one. Building a tenant scope without a tenant throws, so
  // the global call widget polling this from a platform screen used to get a
  // 500 on every heartbeat. There are no calls to show — say so.
  if (!ctx.tenantId) return ok({ calls: [], serverTime: nowIso() }, { ctx });

  const scope = scopeFor(ctx);
  const where = scope.where('call_records', 'cr');
  where.inIf('cr.status', LIVE_STATUSES);
  if (!ctx.has('calls.view')) where.add('cr.agent_id = ?', ctx.userId);

  const rows = await scope.raw(
    `SELECT cr.*, c.display_name AS client_name, c.client_code, u.full_name AS agent_name
       FROM call_records cr
       LEFT JOIN clients c ON c.id = cr.client_id
       LEFT JOIN users u ON u.id = cr.agent_id
      ${where.sql} ORDER BY cr.created_at DESC LIMIT 20`, where.params);

  // Refresh live calls from the provider so a call ended on the handset is
  // reflected here rather than hanging in "in progress" for ever.
  const settings = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  const provider = telephonyProvider(settings?.provider ?? 'exotel', ctx.env);

  const refreshed = [];
  for (const row of rows) {
    let current = row;
    if (provider?.isConfigured() && row.provider_call_id) {
      const live = await provider.getCall(row.provider_call_id);
      if (live.ok && live.data.status && live.data.status !== row.status) {
        await applyProviderUpdate(ctx, scope, row, live.data);
        current = await scope.first('call_records', { id: row.id });
        current.client_name = row.client_name;
        current.agent_name = row.agent_name;
      }
    }
    refreshed.push(current);
  }

  return ok({
    calls: refreshed.filter(c => LIVE_STATUSES.includes(c.status)).map(toCall),
    serverTime: nowIso(),
  }, { ctx });
}, { anyPermission: ['calls.view', 'calls.view.own'] });

// ---------------------------------------------------------------------------
// In-call controls
// ---------------------------------------------------------------------------
router.post('/:id/control', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);

  const body = await ctx.body();
  const input = validate(body, {
    action: { type: 'enum', required: true, values: ['mute', 'unmute', 'hold', 'resume', 'record_on', 'record_off', 'hangup'] },
  });

  const settings = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  const provider = telephonyProvider(call.provider ?? settings?.provider ?? 'exotel', ctx.env);

  // Mute and hold are local UI state on most providers; recording and hangup
  // must reach the vendor, so they fail loudly when it is unavailable.
  const patch = {};
  let providerResult = null;

  switch (input.action) {
    case 'mute': patch.is_muted = 1; break;
    case 'unmute': patch.is_muted = 0; break;
    case 'hold':
      patch.is_on_hold = 1;
      patch.status = 'on_hold';
      break;
    case 'resume':
      patch.is_on_hold = 0;
      patch.status = 'in_progress';
      patch.hold_seconds = (call.hold_seconds ?? 0);
      break;
    case 'record_on':
    case 'record_off': {
      if (settings?.recording_mode === 'disabled') {
        throw new ConflictError('Recording is switched off for this organisation.');
      }
      if (!provider?.isConfigured()) {
        throw new IntegrationError(provider?.name ?? 'Telephony',
          'Recording cannot be changed while the provider is not connected.', { configured: false });
      }
      providerResult = await provider.toggleRecording({
        providerCallId: call.provider_call_id,
        enabled: input.action === 'record_on',
      });
      if (!providerResult.ok) {
        throw new IntegrationError(provider.name, providerResult.error?.message ?? 'Recording could not be changed.');
      }
      patch.is_recording = input.action === 'record_on' ? 1 : 0;
      break;
    }
    case 'hangup': {
      if (provider?.isConfigured() && call.provider_call_id) {
        providerResult = await provider.hangUp(call.provider_call_id);
      }
      patch.status = 'completed';
      patch.ended_at = nowIso();
      patch.duration_seconds = call.started_at ? secondsBetween(call.started_at, nowIso()) : 0;
      patch.talk_seconds = call.answered_at ? secondsBetween(call.answered_at, nowIso()) : 0;
      patch.is_recording = 0;
      break;
    }
  }

  await scope.update('call_records', call.id, patch);

  if (input.action === 'hangup') {
    await setPresence(scope, call.agent_id, 'available');
    ctx.defer(afterCallProcessing(ctx, scope, call.id));
  }

  const updated = await scope.first('call_records', { id: call.id });
  return ok({ call: toCall(updated), action: input.action }, { ctx });
}, { permission: 'calls.place' });

router.post('/:id/transfer', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);

  const body = await ctx.body();
  const input = validate(body, {
    toUserId: { type: 'id' },
    toNumber: { type: 'phone' },
    type: { type: 'enum', values: ['warm', 'cold'], default: 'warm' },
  });

  if (!input.toUserId && !input.toNumber) {
    throw new BadRequestError('Choose a colleague or a number to transfer the call to.');
  }

  let destination = input.toNumber;
  let targetUser = null;
  if (input.toUserId) {
    targetUser = await scope.first('users', { id: input.toUserId }, 'id, full_name, phone');
    if (!targetUser) throw new NotFoundError('User');
    const targetAgent = await scope.first('telephony_agents', { user_id: input.toUserId });
    destination = targetAgent?.direct_number ?? targetUser.phone;
    if (!destination) {
      throw new BadRequestError(`${targetUser.full_name} has no phone number or extension on file.`);
    }
  }

  const provider = telephonyProvider(call.provider, ctx.env);
  if (!provider?.capabilities?.transfer) {
    throw new ConflictError(`${provider?.name ?? 'This provider'} does not support in-call transfer.`);
  }
  if (!provider.isConfigured()) {
    throw new IntegrationError(provider.name, 'The provider is not connected.', { configured: false });
  }

  const result = await provider.transfer({ providerCallId: call.provider_call_id, to: destination });
  if (!result.ok) {
    throw new IntegrationError(provider.name, result.error?.message ?? 'The transfer failed.');
  }

  await scope.update('call_records', call.id, {
    transferred_to: input.toUserId ?? null,
    transferred_at: nowIso(),
    transfer_type: input.type,
  });

  await audit(ctx, {
    action: 'calls.placed', category: 'calls',
    entityType: 'call', entityId: call.id,
    newValue: { transferredTo: input.toUserId ?? destination, type: input.type },
  });

  const updated = await scope.first('call_records', { id: call.id });
  return ok({ call: toCall(updated), transferredTo: targetUser?.full_name ?? destination }, { ctx });
}, { permission: 'calls.transfer' });

/** Conference — add a third party to a live call. */
router.post('/:id/conference', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);

  const body = await ctx.body();
  const input = validate(body, { addNumber: { type: 'phone', required: true } });

  const provider = telephonyProvider(call.provider, ctx.env);
  if (!provider?.capabilities?.conference) {
    throw new ConflictError(`${provider?.name ?? 'This provider'} does not support conference calling.`);
  }
  if (!provider.isConfigured()) {
    throw new IntegrationError(provider.name, 'The provider is not connected.', { configured: false });
  }

  const result = await provider.placeCall({
    from: call.from_number,
    to: input.addNumber,
    callerId: call.virtual_number,
    record: !!call.recording_enabled,
    callbackUrl: `${ctx.env.APP_URL || ''}/webhooks/telephony/${provider.key}`,
  });
  if (!result.ok) throw new IntegrationError(provider.name, result.error?.message ?? 'The party could not be added.');

  const conferenceId = call.conference_id ?? ID.call();
  await scope.update('call_records', call.id, { is_conference: 1, conference_id: conferenceId });

  // The added leg is its own call record, linked by conference id.
  const legId = ID.call();
  await scope.insert('call_records', {
    id: legId,
    company_id: call.company_id,
    client_id: call.client_id,
    agent_id: ctx.userId,
    provider: provider.key,
    provider_call_id: result.data.providerCallId,
    direction: 'outbound',
    from_number: call.from_number,
    to_number: input.addNumber,
    virtual_number: call.virtual_number,
    status: result.data.status ?? 'ringing',
    is_conference: 1,
    conference_id: conferenceId,
    recording_enabled: call.recording_enabled,
    started_at: nowIso(),
  });

  return ok({ conferenceId, addedLegId: legId }, { ctx });
}, { permission: 'calls.transfer' });

// ---------------------------------------------------------------------------
// Call history
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('call_records', 'cr');
  if (!ctx.has('calls.view')) {
    if (ctx.isClient) {
      const db = new Db(ctx.env.DB);
      const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
      if (!ids.length) where.add('1 = 0'); else where.inIf('cr.client_id', ids);
    } else {
      where.add('cr.agent_id = ?', ctx.userId);
    }
  }

  where.eqIf('cr.client_id', ctx.q('clientId'));
  where.eqIf('cr.agent_id', ctx.q('agentId'));
  where.eqIf('cr.direction', ctx.q('direction'));
  where.eqIf('cr.disposition_key', ctx.q('disposition'));
  const statuses = ctx.qList('status');
  if (statuses.length) where.inIf('cr.status', statuses);
  else where.eqIf('cr.status', ctx.q('status'));
  if (ctx.qBool('missedOnly')) where.inIf('cr.status', ['missed', 'no_answer', 'busy']);
  if (ctx.qBool('withRecording')) {
    where.add('EXISTS (SELECT 1 FROM call_recordings r WHERE r.call_id = cr.id AND r.status = \'available\')');
  }
  where.searchIf(['cr.from_number', 'cr.to_number', 'c.display_name'], ctx.q('q'));
  where.betweenIf('cr.created_at', ctx.q('from'), ctx.q('to'));

  const { rows, total } = await scope.paginate('call_records', where, {
    columns: `cr.*, c.display_name AS client_name, c.client_code,
              u.full_name AS agent_name, d.label AS disposition_label, d.outcome AS disposition_outcome,
              r.id AS recording_id, r.duration_seconds AS recording_seconds, r.status AS recording_status,
              a.sentiment, a.summary AS ai_summary,
              (SELECT COUNT(*) FROM call_notes n WHERE n.call_id = cr.id) AS note_count`,
    joins: `LEFT JOIN clients c ON c.id = cr.client_id
            LEFT JOIN users u ON u.id = cr.agent_id
            LEFT JOIN call_dispositions d ON d.id = cr.disposition_id
            LEFT JOIN call_recordings r ON r.call_id = cr.id
            LEFT JOIN call_ai_analysis a ON a.call_id = cr.id`,
    alias: 'cr',
    orderBy: `cr.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'duration_seconds', 'status'], 'created_at')}`,
    page, pageSize,
  });

  const counts = await scope.rawOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
       SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
       SUM(CASE WHEN status IN ('missed','no_answer','busy') THEN 1 ELSE 0 END) AS missed
     FROM call_records WHERE tenant_id = ?`, [ctx.tenantId]);

  return paginated(rows.map(toCall), {
    page, pageSize, total,
    summary: {
      total: Number(counts?.total) || 0,
      inbound: Number(counts?.inbound) || 0,
      outbound: Number(counts?.outbound) || 0,
      missed: Number(counts?.missed) || 0,
    },
  }, ctx);
}, { anyPermission: ['calls.view', 'calls.view.own'] });

router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);

  const [client, agent, notes, recording, transcript, analysis, disposition] = await Promise.all([
    call.client_id ? scope.first('clients', { id: call.client_id }) : null,
    call.agent_id ? scope.first('users', { id: call.agent_id }, 'id, full_name, email, avatar_key') : null,
    scope.raw(
      `SELECT n.*, u.full_name AS author_name FROM call_notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.tenant_id = ? AND n.call_id = ? ORDER BY n.created_at ASC`, [ctx.tenantId, call.id]),
    scope.first('call_recordings', { call_id: call.id }),
    scope.first('call_transcripts', { call_id: call.id }),
    scope.first('call_ai_analysis', { call_id: call.id }),
    call.disposition_id ? scope.first('call_dispositions', { id: call.disposition_id }) : null,
  ]);

  const followUp = call.follow_up_task_id
    ? await scope.first('tasks', { id: call.follow_up_task_id }) : null;

  return ok({
    call: toCall(call),
    client,
    agent,
    notes,
    disposition,
    tags: safeJson(call.tags_json, []),
    recording: recording ? {
      id: recording.id,
      status: recording.status,
      durationSeconds: recording.duration_seconds,
      sizeBytes: recording.size_bytes,
      waveform: safeJson(recording.waveform_json, null),
      available: recording.status === 'available',
      retentionUntil: recording.retention_until,
      playUrl: recording.status === 'available' ? `/api/calls/${call.id}/recording` : null,
    } : null,
    transcript: transcript ? {
      status: transcript.status,
      text: transcript.full_text,
      segments: safeJson(transcript.segments_json, []),
      confidence: transcript.confidence,
      language: transcript.language,
      wordCount: transcript.word_count,
      error: transcript.error_message,
    } : null,
    ai: analysis ? {
      status: analysis.status,
      summary: analysis.summary,
      keyPoints: safeJson(analysis.key_points_json, []),
      actionItems: safeJson(analysis.action_items_json, []),
      sentiment: analysis.sentiment,
      sentimentScore: analysis.sentiment_score,
      topics: safeJson(analysis.topics_json, []),
      nextStep: analysis.next_step,
      model: analysis.model,
      error: analysis.error_message,
      disclaimer: analysis.status === 'done'
        ? 'This summary and sentiment were generated from the call transcript. Check anything you rely on.'
        : null,
    } : null,
    followUpTask: followUp,
    permissions: {
      canListen: ctx.has('calls.recordings.listen'),
      canDownload: ctx.has('calls.recordings.download'),
      canNote: ctx.has('calls.notes'),
    },
  }, { ctx });
}, { anyPermission: ['calls.view', 'calls.view.own'] });

/** The client's call timeline — "Call Timeline" in the feature table. */
router.get('/timeline/:clientId', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.raw(
    `SELECT cr.*, u.full_name AS agent_name, d.label AS disposition_label,
            a.sentiment, a.summary AS ai_summary, r.status AS recording_status
       FROM call_records cr
       LEFT JOIN users u ON u.id = cr.agent_id
       LEFT JOIN call_dispositions d ON d.id = cr.disposition_id
       LEFT JOIN call_ai_analysis a ON a.call_id = cr.id
       LEFT JOIN call_recordings r ON r.call_id = cr.id
      WHERE cr.tenant_id = ? AND cr.client_id = ?
      ORDER BY cr.created_at DESC LIMIT 100`, [ctx.tenantId, ctx.params.clientId]);

  return ok(rows.map(toCall), { ctx });
}, { anyPermission: ['calls.view', 'calls.view.own'] });

// ---------------------------------------------------------------------------
// Notes, disposition and tags
// ---------------------------------------------------------------------------
router.post('/:id/notes', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);

  const body = await ctx.body();
  const input = validate(body, {
    body: { type: 'text', required: true, max: 4000 },
    duringCall: { type: 'boolean', default: false },
  });

  const note = await scope.insert('call_notes', {
    id: ID.callNote(),
    call_id: call.id,
    author_id: ctx.userId,
    body: input.body,
    is_during_call: input.duringCall ? 1 : 0,
  });

  if (call.client_id) {
    await recordActivity(ctx, {
      clientId: call.client_id, companyId: call.company_id,
      verb: 'noted', entityType: 'call', entityId: call.id,
      summary: `${ctx.user.full_name} added a call note`,
      detail: { note: input.body.slice(0, 200) },
      visibility: 'internal', icon: 'phone',
    });
  }

  return created({ ...note, author_name: ctx.user.full_name }, { ctx });
}, { permission: 'calls.notes' });

router.post('/:id/disposition', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);

  const body = await ctx.body();
  const input = validate(body, {
    dispositionKey: { type: 'string', required: true, max: 40 },
    tags: { type: 'array', max: 10, of: { type: 'string', max: 40 } },
    note: { type: 'text', max: 2000 },
    followUpAt: { type: 'date' },
    createTask: { type: 'boolean' },
  });

  const disposition = await scope.first('call_dispositions', { key: input.dispositionKey });
  if (!disposition) throw new NotFoundError('Disposition');

  await scope.update('call_records', call.id, {
    disposition_id: disposition.id,
    disposition_key: disposition.key,
    tags_json: input.tags ? JSON.stringify(input.tags) : call.tags_json,
    follow_up_at: input.followUpAt,
  });

  if (input.note) {
    await scope.insert('call_notes', {
      id: ID.callNote(), call_id: call.id, author_id: ctx.userId,
      body: input.note, is_during_call: 0,
    });
  }

  // Keep the tag vocabulary and its usage counts current.
  for (const label of input.tags ?? []) {
    const existing = await scope.first('call_tags', { label });
    if (existing) await scope.update('call_tags', existing.id, { usage_count: (existing.usage_count ?? 0) + 1 });
    else await scope.insert('call_tags', { id: ID.tag(), label, usage_count: 1 });
  }

  // "Follow-up Reminder after Call" and "Auto Create Task after Call".
  const settings = await scope.first('telephony_settings', { tenant_id: ctx.tenantId });
  const shouldCreateTask = input.createTask ?? (
    disposition.requires_follow_up && settings?.auto_create_task);

  let task = null;
  if (shouldCreateTask) {
    const client = call.client_id ? await scope.first('clients', { id: call.client_id }) : null;
    task = await scope.insert('tasks', {
      id: ID.task(),
      company_id: call.company_id,
      client_id: call.client_id,
      title: `Follow up: ${client?.display_name ?? call.to_number}`,
      description: input.note ?? `Follow-up from the call on ${dayKey()} (${disposition.label}).`,
      type: 'call_follow_up',
      status: 'todo',
      priority: disposition.outcome === 'negative' ? 'high' : 'normal',
      assigned_to: call.agent_id ?? ctx.userId,
      created_by: ctx.userId,
      due_at: input.followUpAt ?? addDays(1),
      reminder_at: input.followUpAt ?? addHours(20),
      source_type: 'call',
      source_id: call.id,
    });
    await scope.update('call_records', call.id, { follow_up_task_id: task.id });
  }

  await audit(ctx, {
    action: 'calls.placed', category: 'calls',
    entityType: 'call', entityId: call.id,
    newValue: { disposition: disposition.key, tags: input.tags ?? [], followUpTask: task?.id ?? null },
  });

  const updated = await scope.first('call_records', { id: call.id });
  return ok({ call: toCall(updated), disposition, followUpTask: task }, { ctx });
}, { permission: 'calls.notes' });

/** Missed call tracking — mark a missed call handled, optionally calling back. */
router.post('/:id/missed/handle', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);
  if (!['missed', 'no_answer', 'busy'].includes(call.status)) {
    throw new ConflictError('That call was not missed.');
  }

  const body = await ctx.body();
  const input = validate(body, { callbackAt: { type: 'date' }, note: { type: 'text', max: 1000 } });

  await scope.update('call_records', call.id, {
    missed_handled: 1,
    missed_callback_at: input.callbackAt,
  });
  if (input.note) {
    await scope.insert('call_notes', {
      id: ID.callNote(), call_id: call.id, author_id: ctx.userId, body: input.note, is_during_call: 0,
    });
  }

  const updated = await scope.first('call_records', { id: call.id });
  return ok({ call: toCall(updated) }, { ctx });
}, { permission: 'calls.notes' });

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------
router.get('/:id/recording', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);
  const recording = await scope.first('call_recordings', { call_id: call.id });

  if (!recording || recording.status !== 'available' || !recording.storage_key) {
    throw new NotFoundError('Recording', 'No recording is stored for this call.');
  }

  const download = ctx.qBool('download');
  if (download && !ctx.has('calls.recordings.download')) {
    throw new ForbiddenError('You may listen to recordings but not download them.');
  }

  const object = await getObject(ctx.env, recording.storage_key);

  if (download) {
    await scope.update('call_recordings', recording.id, {
      downloaded_count: (recording.downloaded_count ?? 0) + 1,
    });
    auditAsync(ctx, {
      action: 'calls.recording_downloaded', category: 'calls', severity: 'notice',
      entityType: 'call', entityId: call.id,
      metadata: { recordingId: recording.id },
    });
  }

  return fileResponse(object.body, {
    contentType: recording.mime_type ?? 'audio/mpeg',
    fileName: `call-${call.id}.${(recording.mime_type ?? '').includes('wav') ? 'wav' : 'mp3'}`,
    download,
    cacheSeconds: 300,
  });
}, { permission: 'calls.recordings.listen' });

/** Search recordings by their transcript — "Search Call Recordings". */
router.get('/recordings/search', async (ctx) => {
  await assertFeature(ctx, 'call_recording');
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();
  const term = ctx.q('q');

  const where = scope.where('call_recordings', 'r');
  where.add("r.status = 'available'");
  if (!ctx.has('calls.view')) where.add('cr.agent_id = ?', ctx.userId);
  where.eqIf('cr.client_id', ctx.q('clientId'));
  where.eqIf('cr.agent_id', ctx.q('agentId'));
  where.betweenIf('cr.created_at', ctx.q('from'), ctx.q('to'));
  if (term) {
    where.add('(LOWER(COALESCE(t.full_text, \'\')) LIKE ? OR LOWER(COALESCE(a.summary, \'\')) LIKE ?)',
      `%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`);
  }

  const { rows, total } = await scope.paginate('call_recordings', where, {
    columns: `r.*, cr.id AS call_id, cr.direction, cr.from_number, cr.to_number, cr.created_at AS call_at,
              c.display_name AS client_name, u.full_name AS agent_name,
              a.sentiment, a.summary AS ai_summary, t.full_text AS transcript`,
    joins: `JOIN call_records cr ON cr.id = r.call_id
            LEFT JOIN clients c ON c.id = cr.client_id
            LEFT JOIN users u ON u.id = cr.agent_id
            LEFT JOIN call_ai_analysis a ON a.call_id = cr.id
            LEFT JOIN call_transcripts t ON t.call_id = cr.id`,
    alias: 'r',
    orderBy: 'cr.created_at DESC',
    page, pageSize,
  });

  return paginated(rows.map(r => ({
    recordingId: r.id,
    callId: r.call_id,
    direction: r.direction,
    fromNumber: r.from_number,
    toNumber: r.to_number,
    clientName: r.client_name,
    agentName: r.agent_name,
    durationSeconds: r.duration_seconds,
    sizeBytes: r.size_bytes,
    calledAt: r.call_at,
    sentiment: r.sentiment,
    aiSummary: r.ai_summary,
    // The matching snippet, so search results are readable at a glance.
    snippet: term && r.transcript ? snippetAround(r.transcript, term) : null,
    playUrl: `/api/calls/${r.call_id}/recording`,
  })), { page, pageSize, total, searchTerm: term }, ctx);
}, { permission: 'calls.recordings.listen' });

/** Re-run transcription and AI analysis on an existing recording. */
router.post('/:id/analyse', async (ctx) => {
  const scope = scopeFor(ctx);
  const call = await getVisibleCall(ctx, scope, ctx.params.id);
  const result = await runCallIntelligence(ctx, scope, call, { force: true });
  return ok(result, { ctx });
}, { permission: 'calls.notes' });

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
router.get('/analytics/overview', async (ctx) => {
  const scope = scopeFor(ctx);
  const from = ctx.q('from') ?? addDays(-30);
  const to = ctx.q('to') ?? nowIso();

  const totals = await scope.rawOne(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
       SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
       SUM(CASE WHEN status IN ('missed','no_answer','busy') THEN 1 ELSE 0 END) AS missed,
       SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END) AS answered,
       COALESCE(SUM(duration_seconds),0) AS total_duration,
       COALESCE(AVG(NULLIF(duration_seconds,0)),0) AS avg_duration
     FROM call_records WHERE tenant_id = ? AND created_at BETWEEN ? AND ?`,
    [ctx.tenantId, from, to]);

  const sentiment = await scope.raw(
    `SELECT a.sentiment, COUNT(*) AS n FROM call_ai_analysis a
       JOIN call_records cr ON cr.id = a.call_id
      WHERE a.tenant_id = ? AND cr.created_at BETWEEN ? AND ? AND a.sentiment IS NOT NULL
      GROUP BY a.sentiment`, [ctx.tenantId, from, to]);

  const byDay = await scope.raw(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n,
            SUM(CASE WHEN status IN ('missed','no_answer','busy') THEN 1 ELSE 0 END) AS missed
       FROM call_records WHERE tenant_id = ? AND created_at BETWEEN ? AND ?
      GROUP BY day ORDER BY day`, [ctx.tenantId, from, to]);

  const outcomes = await scope.raw(
    `SELECT COALESCE(d.label, 'No disposition') AS label, COUNT(*) AS n
       FROM call_records cr LEFT JOIN call_dispositions d ON d.id = cr.disposition_id
      WHERE cr.tenant_id = ? AND cr.created_at BETWEEN ? AND ?
      GROUP BY label ORDER BY n DESC LIMIT 10`, [ctx.tenantId, from, to]);

  const total = Number(totals?.total) || 0;
  const sentimentCounts = Object.fromEntries(sentiment.map(s => [s.sentiment, Number(s.n)]));
  const sentimentTotal = Object.values(sentimentCounts).reduce((a, b) => a + b, 0);

  return ok({
    period: { from, to },
    totalCalls: total,
    inbound: Number(totals?.inbound) || 0,
    outbound: Number(totals?.outbound) || 0,
    missedCalls: Number(totals?.missed) || 0,
    answeredCalls: Number(totals?.answered) || 0,
    totalDurationSeconds: Number(totals?.total_duration) || 0,
    avgDurationSeconds: Math.round(Number(totals?.avg_duration) || 0),
    avgDurationLabel: formatDuration(Number(totals?.avg_duration) || 0),
    answerRatePct: total ? Math.round(((Number(totals?.answered) || 0) / total) * 100) : null,
    sentiment: sentimentCounts,
    positiveSentimentPct: sentimentTotal
      ? Math.round(((sentimentCounts.positive ?? 0) / sentimentTotal) * 100) : null,
    callsPerDay: byDay.map(d => ({ day: d.day, calls: Number(d.n), missed: Number(d.missed) })),
    outcomes: outcomes.map(o => ({ label: o.label, count: Number(o.n) })),
  }, { ctx });
}, { permission: 'calls.analytics' });

/** The Employee Call Performance Dashboard. */
router.get('/analytics/performance', async (ctx) => {
  const scope = scopeFor(ctx);
  const from = ctx.q('from') ?? addDays(-30);
  const to = ctx.q('to') ?? nowIso();

  const rows = await scope.raw(
    `SELECT u.id, u.full_name, u.avatar_key,
            COUNT(cr.id) AS total,
            SUM(CASE WHEN cr.status IN ('missed','no_answer','busy') THEN 1 ELSE 0 END) AS missed,
            SUM(CASE WHEN cr.answered = 1 THEN 1 ELSE 0 END) AS answered,
            COALESCE(SUM(cr.duration_seconds),0) AS total_duration,
            COALESCE(AVG(NULLIF(cr.duration_seconds,0)),0) AS avg_duration,
            SUM(CASE WHEN a.sentiment = 'positive' THEN 1 ELSE 0 END) AS positive,
            SUM(CASE WHEN a.sentiment = 'negative' THEN 1 ELSE 0 END) AS negative,
            SUM(CASE WHEN cr.follow_up_task_id IS NOT NULL THEN 1 ELSE 0 END) AS follow_ups
       FROM users u
       LEFT JOIN call_records cr ON cr.agent_id = u.id AND cr.created_at BETWEEN ? AND ?
       LEFT JOIN call_ai_analysis a ON a.call_id = cr.id
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status = 'active'
      GROUP BY u.id, u.full_name, u.avatar_key
      HAVING total > 0
      ORDER BY total DESC LIMIT 50`, [from, to, ctx.tenantId]);

  const leaderboard = rows.map(r => {
    const total = Number(r.total) || 0;
    const positive = Number(r.positive) || 0;
    const answered = Number(r.answered) || 0;
    // A simple, explainable rating out of 5: answer rate and sentiment.
    const answerRate = total ? answered / total : 0;
    const sentimentRate = total ? positive / total : 0;
    const rating = Number((1 + answerRate * 2 + sentimentRate * 2).toFixed(1));

    return {
      id: r.id,
      name: r.full_name,
      avatarKey: r.avatar_key,
      calls: total,
      missed: Number(r.missed) || 0,
      answered,
      totalDurationSeconds: Number(r.total_duration) || 0,
      avgDurationSeconds: Math.round(Number(r.avg_duration) || 0),
      avgDurationLabel: formatDuration(Number(r.avg_duration) || 0),
      positive,
      negative: Number(r.negative) || 0,
      followUps: Number(r.follow_ups) || 0,
      answerRatePct: Math.round(answerRate * 100),
      rating: Math.min(5, rating),
    };
  });

  const totals = leaderboard.reduce((acc, a) => ({
    calls: acc.calls + a.calls,
    missed: acc.missed + a.missed,
    duration: acc.duration + a.totalDurationSeconds,
    positive: acc.positive + a.positive,
  }), { calls: 0, missed: 0, duration: 0, positive: 0 });

  return ok({
    period: { from, to },
    totals: {
      totalCalls: totals.calls,
      missedCalls: totals.missed,
      avgDurationSeconds: totals.calls ? Math.round(totals.duration / totals.calls) : 0,
      avgDurationLabel: formatDuration(totals.calls ? totals.duration / totals.calls : 0),
      positiveSentimentPct: totals.calls ? Math.round((totals.positive / totals.calls) * 100) : null,
    },
    leaderboard,
  }, { ctx });
}, { permission: 'calls.analytics' });

/** Daily / weekly / monthly call reports. */
router.get('/analytics/reports', async (ctx) => {
  const scope = scopeFor(ctx);
  const grouping = ctx.q('grouping', 'daily');

  const expr = grouping === 'monthly' ? "substr(day, 1, 7)"
    : grouping === 'weekly' ? "strftime('%Y-W%W', day)"
    : 'day';

  const rows = await scope.raw(
    `SELECT ${expr} AS bucket,
            SUM(total_calls) AS calls,
            SUM(inbound_calls) AS inbound,
            SUM(outbound_calls) AS outbound,
            SUM(missed_calls) AS missed,
            SUM(total_duration_sec) AS duration,
            SUM(positive_count) AS positive,
            SUM(negative_count) AS negative
       FROM call_metrics_daily WHERE tenant_id = ?
      GROUP BY bucket ORDER BY bucket DESC LIMIT 60`, [ctx.tenantId]);

  return ok({
    grouping,
    buckets: rows.map(r => ({
      bucket: r.bucket,
      calls: Number(r.calls) || 0,
      inbound: Number(r.inbound) || 0,
      outbound: Number(r.outbound) || 0,
      missed: Number(r.missed) || 0,
      durationSeconds: Number(r.duration) || 0,
      durationLabel: formatDuration(Number(r.duration) || 0),
      positive: Number(r.positive) || 0,
      negative: Number(r.negative) || 0,
    })),
  }, { ctx });
}, { permission: 'calls.analytics' });

// ---------------------------------------------------------------------------
// Voicemail & IVR
// ---------------------------------------------------------------------------
router.get('/voicemails', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();
  const where = scope.where('voicemails', 'v');
  where.eqIf('v.status', ctx.q('status'));
  if (!ctx.has('calls.view')) where.add('(v.assigned_to = ? OR v.assigned_to IS NULL)', ctx.userId);

  const { rows, total } = await scope.paginate('voicemails', where, {
    columns: 'v.*, c.display_name AS client_name, u.full_name AS assignee_name',
    joins: `LEFT JOIN clients c ON c.id = v.client_id
            LEFT JOIN users u ON u.id = v.assigned_to`,
    alias: 'v', orderBy: 'v.created_at DESC', page, pageSize,
  });

  return paginated(rows, { page, pageSize, total }, ctx);
}, { anyPermission: ['calls.view', 'calls.view.own'] });

router.post('/voicemails/:id/status', async (ctx) => {
  const scope = scopeFor(ctx);
  const voicemail = await scope.getOrFail('voicemails', ctx.params.id, { resource: 'Voicemail' });
  const body = await ctx.body();
  const input = validate(body, {
    status: { type: 'enum', required: true, values: ['new', 'heard', 'actioned', 'archived'] },
  });

  await scope.update('voicemails', voicemail.id, {
    status: input.status,
    heard_at: input.status === 'heard' && !voicemail.heard_at ? nowIso() : voicemail.heard_at,
  });

  const updated = await scope.first('voicemails', { id: voicemail.id });
  return ok(updated, { ctx });
}, { permission: 'calls.notes' });

router.get('/ivr', async (ctx) => {
  const scope = scopeFor(ctx);
  const flows = await scope.all('ivr_flows', {}, { order: 'created_at DESC' });
  return ok(flows.map(f => ({ ...f, nodes: safeJson(f.nodes_json, []) })), { ctx });
}, { permission: 'calls.configure' });

router.post('/ivr', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    description: { type: 'text', max: 1000 },
    greetingText: { type: 'text', max: 2000 },
    nodes: { type: 'array', required: true, max: 20 },
    afterHoursAction: { type: 'enum', values: ['voicemail', 'message', 'forward', 'hangup'], default: 'voicemail' },
    businessHours: { type: 'json' },
    isActive: { type: 'boolean', default: false },
  });

  const flow = await scope.insert('ivr_flows', {
    id: ID.ivr(),
    name: input.name,
    description: input.description,
    greeting_text: input.greetingText,
    nodes_json: JSON.stringify(input.nodes),
    business_hours_json: input.businessHours ? JSON.stringify(input.businessHours) : null,
    after_hours_action: input.afterHoursAction,
    is_active: input.isActive ? 1 : 0,
  });

  if (input.isActive) {
    await scope.updateWhere('telephony_settings', { tenant_id: ctx.tenantId }, { ivr_enabled: 1 });
  }

  auditAsync(ctx, {
    action: 'calls.settings_changed', category: 'calls',
    entityType: 'ivr_flow', entityId: flow.id, entityLabel: input.name,
    newValue: { nodes: input.nodes.length, active: input.isActive },
  });

  return created({ ...flow, nodes: input.nodes }, { ctx });
}, { permission: 'calls.configure' });

// ---------------------------------------------------------------------------
// Agents & dispositions
// ---------------------------------------------------------------------------
router.post('/agents', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    userId: { type: 'id', required: true },
    extension: { type: 'string', max: 12 },
    directNumber: { type: 'phone' },
    providerAgentId: { type: 'string', max: 60 },
  });

  const user = await scope.first('users', { id: input.userId }, 'id, full_name');
  if (!user) throw new NotFoundError('User');

  const existing = await scope.first('telephony_agents', { user_id: input.userId });
  if (existing) {
    await scope.update('telephony_agents', existing.id, {
      extension: input.extension, direct_number: input.directNumber,
      provider_agent_id: input.providerAgentId, is_active: 1,
    });
    return ok(await scope.first('telephony_agents', { id: existing.id }), { ctx });
  }

  const agent = await scope.insert('telephony_agents', {
    id: ID.agent(),
    user_id: input.userId,
    extension: input.extension,
    direct_number: input.directNumber,
    provider_agent_id: input.providerAgentId,
    presence: 'offline',
    is_active: 1,
  });
  return created(agent, { ctx });
}, { permission: 'calls.configure' });

router.post('/presence', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    presence: { type: 'enum', required: true, values: ['offline', 'available', 'busy', 'away', 'dnd'] },
  });
  await setPresence(scope, ctx.userId, input.presence);
  return ok({ presence: input.presence }, { ctx });
}, { anyPermission: ['calls.place', 'calls.receive'] });

router.post('/dispositions', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    key: { type: 'string', required: true, max: 40 },
    label: { type: 'string', required: true, max: 80 },
    outcome: { type: 'enum', values: ['positive', 'neutral', 'negative'], default: 'neutral' },
    requiresFollowUp: { type: 'boolean', default: false },
    colour: { type: 'string', max: 12 },
    sortOrder: { type: 'int', min: 0, max: 999, default: 100 },
  });

  const disposition = await scope.insert('call_dispositions', {
    id: ID.disposition(),
    key: input.key.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
    label: input.label,
    outcome: input.outcome,
    requires_follow_up: input.requiresFollowUp ? 1 : 0,
    colour: input.colour,
    sort_order: input.sortOrder,
    is_active: 1,
  });
  return created(disposition, { ctx });
}, { permission: 'calls.configure' });

// ---------------------------------------------------------------------------
// Shared logic
// ---------------------------------------------------------------------------

/** Apply a provider status update to a call row. */
export async function applyProviderUpdate(ctx, scope, call, update) {
  const patch = {};
  if (update.status && update.status !== call.status) patch.status = update.status;
  if (update.durationSeconds) patch.duration_seconds = update.durationSeconds;
  if (update.startedAt && !call.started_at) patch.started_at = update.startedAt;
  if (update.endedAt) patch.ended_at = update.endedAt;

  if (update.status === 'in_progress' && !call.answered_at) {
    patch.answered = 1;
    patch.answered_at = update.startedAt ?? nowIso();
  }
  if (['completed', 'missed', 'no_answer', 'busy', 'failed', 'cancelled', 'voicemail'].includes(update.status)) {
    patch.ended_at = patch.ended_at ?? nowIso();
    patch.is_recording = 0;
    if (!patch.duration_seconds && call.started_at) {
      patch.duration_seconds = secondsBetween(call.started_at, patch.ended_at);
    }
    if (call.answered_at) patch.talk_seconds = secondsBetween(call.answered_at, patch.ended_at);
  }

  if (Object.keys(patch).length) await scope.update('call_records', call.id, patch);

  // Store the recording once the provider publishes it.
  if (update.recordingUrl) {
    await ingestRecording(ctx, scope, { ...call, ...patch }, update.recordingUrl);
  }

  if (patch.status && !LIVE_STATUSES.includes(patch.status)) {
    await setPresence(scope, call.agent_id, 'available');
    ctx.defer?.(afterCallProcessing(ctx, scope, call.id));
  }

  return patch;
}

/** Pull a recording from the provider into R2 and record it. */
export async function ingestRecording(ctx, scope, call, providerUrl) {
  const existing = await scope.first('call_recordings', { call_id: call.id });
  if (existing?.status === 'available') return existing;

  const settings = await scope.first('telephony_settings', { tenant_id: scope.tenantId });
  const provider = telephonyProvider(call.provider, ctx.env);

  const recordingId = existing?.id ?? ID.recording();
  const base = {
    id: recordingId,
    call_id: call.id,
    provider_url: providerUrl,
    duration_seconds: call.duration_seconds ?? 0,
    retention_until: addDays(settings?.recording_retention_days ?? 365),
  };

  if (!provider?.isConfigured()) {
    if (!existing) await scope.insert('call_recordings', { ...base, status: 'not_configured' });
    return null;
  }

  const fetched = await provider.fetchRecording(providerUrl);
  if (!fetched.ok) {
    if (existing) await scope.update('call_recordings', recordingId, { status: 'failed' });
    else await scope.insert('call_recordings', { ...base, status: 'failed' });
    return null;
  }

  const bytes = new Uint8Array(fetched.data.buffer);
  const key = recordingKey({
    tenantId: scope.tenantId,
    callId: call.id,
    fileName: `recording.${fetched.data.contentType.includes('wav') ? 'wav' : 'mp3'}`,
  });
  const stored = await putObject(ctx.env, key, bytes, {
    contentType: fetched.data.contentType,
    metadata: { callId: call.id, tenantId: scope.tenantId },
  });

  const row = {
    ...base,
    storage_key: key,
    mime_type: fetched.data.contentType,
    size_bytes: stored.size,
    status: 'available',
    waveform_json: JSON.stringify(buildWaveform(bytes)),
  };

  if (existing) await scope.update('call_recordings', recordingId, row);
  else await scope.insert('call_recordings', row);

  return scope.first('call_recordings', { id: recordingId });
}

/**
 * Everything that happens once a call ends: transcription, AI summary and
 * sentiment, the timeline entry and the daily metric rollup.
 */
export async function afterCallProcessing(ctx, scope, callId) {
  const call = await scope.first('call_records', { id: callId });
  if (!call) return null;

  const settings = await scope.first('telephony_settings', { tenant_id: scope.tenantId });

  if (settings?.auto_log_activity && call.client_id) {
    await recordActivity(ctx, {
      clientId: call.client_id,
      companyId: call.company_id,
      verb: 'called',
      entityType: 'call',
      entityId: call.id,
      summary: `${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call — ${formatDuration(call.duration_seconds)}`,
      detail: { from: call.from_number, to: call.to_number, status: call.status },
      visibility: 'internal',
      icon: 'phone',
    });
  }

  if (['missed', 'no_answer'].includes(call.status)) {
    ctx.defer?.(dispatchNotification(ctx, {
      triggerKey: 'call.missed',
      userId: call.agent_id,
      clientId: call.client_id,
      entityType: 'call', entityId: call.id,
      variables: { from: call.from_number },
      link: { path: `/calls/${call.id}` },
    }));
  }

  const intelligence = await runCallIntelligence(ctx, scope, call, { force: false });
  await rollUpDay(scope, call);

  return { call, intelligence };
}

/** Transcribe and analyse a call, honouring the tenant's switches. */
export async function runCallIntelligence(ctx, scope, call, { force = false } = {}) {
  const settings = await scope.first('telephony_settings', { tenant_id: scope.tenantId });
  const result = { transcription: null, analysis: null };

  const wantsTranscript = force || settings?.transcription_enabled;
  const wantsAnalysis = force || settings?.ai_summary_enabled || settings?.sentiment_enabled;
  if (!wantsTranscript && !wantsAnalysis) return result;

  const recording = await scope.first('call_recordings', { call_id: call.id });
  if (!recording || recording.status !== 'available' || !recording.storage_key) {
    result.transcription = { ok: false, reason: 'No stored recording to work from.' };
    return result;
  }

  // ---- Transcription -------------------------------------------------------
  let transcript = await scope.first('call_transcripts', { call_id: call.id });
  if (wantsTranscript && (force || !transcript || transcript.status !== 'done')) {
    const provider = new SpeechProvider(ctx.env);
    const transcriptId = transcript?.id ?? ID.transcript();

    if (!provider.isConfigured()) {
      const row = {
        id: transcriptId, call_id: call.id, provider: provider.key,
        status: 'not_configured',
        error_message: `Not connected. Missing: ${provider.missingKeys().join(', ')}.`,
      };
      if (transcript) await scope.update('call_transcripts', transcriptId, row);
      else await scope.insert('call_transcripts', row);
      result.transcription = { ok: false, configured: false, missingKeys: provider.missingKeys() };
    } else {
      if (transcript) await scope.update('call_transcripts', transcriptId, { status: 'processing' });
      else await scope.insert('call_transcripts', { id: transcriptId, call_id: call.id, provider: provider.key, status: 'processing' });

      const object = await getObject(ctx.env, recording.storage_key);
      const transcribed = await provider.transcribe(await object.arrayBuffer(), {
        encoding: recording.mime_type?.includes('wav') ? 'LINEAR16' : 'ENCODING_UNSPECIFIED',
        durationSeconds: recording.duration_seconds ?? 0,
      });

      if (transcribed.ok) {
        await scope.update('call_transcripts', transcriptId, {
          status: 'done',
          language: transcribed.data.languageCode,
          full_text: transcribed.data.text,
          segments_json: JSON.stringify(transcribed.data.segments),
          confidence: transcribed.data.confidence,
          word_count: transcribed.data.wordCount,
          error_message: null,
        });
        result.transcription = { ok: true, wordCount: transcribed.data.wordCount };
      } else {
        await scope.update('call_transcripts', transcriptId, {
          status: 'failed', error_message: transcribed.error?.message ?? 'Transcription failed.',
        });
        result.transcription = { ok: false, error: transcribed.error };
      }
      transcript = await scope.first('call_transcripts', { id: transcriptId });
    }
  }

  // ---- Summary and sentiment ----------------------------------------------
  if (wantsAnalysis) {
    const existing = await scope.first('call_ai_analysis', { call_id: call.id });
    if (force && existing) await scope.delete('call_ai_analysis', existing.id);
    if (force || !existing || existing.status !== 'done') {
      result.analysis = await analyseCall(ctx, scope, { call, transcript });
    }
  }

  return result;
}

async function rollUpDay(scope, call) {
  const day = (call.created_at ?? nowIso()).slice(0, 10);
  const row = await scope.rawOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
            SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
            SUM(CASE WHEN status IN ('missed','no_answer','busy') THEN 1 ELSE 0 END) AS missed,
            SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END) AS answered,
            COALESCE(SUM(duration_seconds),0) AS duration,
            SUM(CASE WHEN follow_up_task_id IS NOT NULL THEN 1 ELSE 0 END) AS follow_ups
       FROM call_records
      WHERE tenant_id = ? AND agent_id IS ? AND substr(created_at, 1, 10) = ?`,
    [scope.tenantId, call.agent_id ?? null, day]);

  const total = Number(row?.total) || 0;
  const duration = Number(row?.duration) || 0;

  await scope.db.run(
    `INSERT INTO call_metrics_daily
       (id, tenant_id, agent_id, day, total_calls, inbound_calls, outbound_calls, missed_calls,
        answered_calls, total_duration_sec, avg_duration_sec, follow_ups_created, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tenant_id, agent_id, day) DO UPDATE SET
       total_calls = excluded.total_calls, inbound_calls = excluded.inbound_calls,
       outbound_calls = excluded.outbound_calls, missed_calls = excluded.missed_calls,
       answered_calls = excluded.answered_calls, total_duration_sec = excluded.total_duration_sec,
       avg_duration_sec = excluded.avg_duration_sec, follow_ups_created = excluded.follow_ups_created,
       updated_at = excluded.updated_at`,
    [`mtr_${scope.tenantId}_${call.agent_id ?? 'none'}_${day}`, scope.tenantId, call.agent_id, day,
     total, Number(row?.inbound) || 0, Number(row?.outbound) || 0, Number(row?.missed) || 0,
     Number(row?.answered) || 0, duration, total ? Math.round(duration / total) : 0,
     Number(row?.follow_ups) || 0, nowIso()]);
}

/** Match an incoming or dialled number to a client — the incoming-call popup. */
export async function matchClientByNumber(scope, number) {
  const e164 = toE164(number);
  const last10 = String(number).replace(/\D/g, '').slice(-10);
  if (!last10) return null;

  return scope.rawOne(
    `SELECT c.* FROM clients c
      WHERE c.tenant_id = ? AND c.deleted_at IS NULL
        AND (
          replace(replace(COALESCE(c.primary_contact_phone,''), '+', ''), ' ', '') LIKE ?
          OR EXISTS (
            SELECT 1 FROM client_contacts cc
             WHERE cc.client_id = c.id
               AND replace(replace(COALESCE(cc.phone,''), '+', ''), ' ', '') LIKE ?)
        )
      LIMIT 1`,
    [scope.tenantId, `%${last10}`, `%${last10}`]);
}

async function setPresence(scope, userId, presence) {
  if (!userId) return;
  const agent = await scope.first('telephony_agents', { user_id: userId });
  if (agent) {
    await scope.update('telephony_agents', agent.id, { presence, presence_updated_at: nowIso() });
  }
}

async function getVisibleCall(ctx, scope, callId) {
  const call = await scope.first('call_records', { id: callId });
  if (!call) throw new NotFoundError('Call');
  if (!ctx.has('calls.view')) {
    if (ctx.isClient) {
      const db = new Db(ctx.env.DB);
      const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
      if (!ids.includes(call.client_id)) throw new NotFoundError('Call');
    } else if (call.agent_id !== ctx.userId) {
      throw new NotFoundError('Call');
    }
  }
  return call;
}

/** A coarse amplitude envelope for the player's waveform. */
function buildWaveform(bytes, buckets = 80) {
  const step = Math.max(1, Math.floor(bytes.length / buckets));
  const out = [];
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * step;
    for (let j = start; j < Math.min(start + step, bytes.length); j += 16) {
      peak = Math.max(peak, Math.abs(bytes[j] - 128));
    }
    out.push(Math.min(100, Math.round((peak / 128) * 100)));
  }
  return out;
}

function snippetAround(text, term, radius = 90) {
  const idx = String(text).toLowerCase().indexOf(String(term).toLowerCase());
  if (idx === -1) return String(text).slice(0, radius * 2) + '…';
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function toCall(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    clientCode: row.client_code ?? null,
    contactId: row.contact_id,
    leadId: row.lead_id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? null,
    provider: row.provider,
    providerCallId: row.provider_call_id,
    direction: row.direction,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    virtualNumber: row.virtual_number,
    status: row.status,
    isLive: LIVE_STATUSES.includes(row.status),
    answered: !!row.answered,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    durationLabel: formatDuration(row.duration_seconds),
    talkSeconds: row.talk_seconds,
    isMuted: !!row.is_muted,
    isOnHold: !!row.is_on_hold,
    isRecording: !!row.is_recording,
    recordingEnabled: !!row.recording_enabled,
    recordingStatus: row.recording_status ?? null,
    recordingSeconds: row.recording_seconds ?? null,
    transferredTo: row.transferred_to,
    transferType: row.transfer_type,
    isConference: !!row.is_conference,
    conferenceId: row.conference_id,
    dispositionKey: row.disposition_key,
    dispositionLabel: row.disposition_label ?? null,
    dispositionOutcome: row.disposition_outcome ?? null,
    tags: safeJson(row.tags_json, []),
    noteCount: Number(row.note_count ?? 0),
    sentiment: row.sentiment ?? null,
    aiSummary: row.ai_summary ?? null,
    followUpTaskId: row.follow_up_task_id,
    followUpAt: row.follow_up_at,
    missedHandled: !!row.missed_handled,
    entityType: row.entity_type,
    entityId: row.entity_id,
    createdAt: row.created_at,
  };
}

function pruneNull(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}
function boolToInt(v) { return v === null || v === undefined ? undefined : (v ? 1 : 0); }
function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}
function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as callsRouter, toCall, LIVE_STATUSES, CALL_STATUS };
