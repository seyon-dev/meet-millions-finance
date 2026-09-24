/**
 * Cloud telephony providers.
 *
 * The addendum names seven: Exotel, Knowlarity, MyOperator, Twilio, Plivo,
 * RingCentral and Aircall. They sit behind one `TelephonyProvider` contract so
 * the calling module never branches on vendor:
 *
 *   placeCall(...)        → dial out, returning a provider call id
 *   getCall(...)          → live status of a call
 *   hangUp(...)           → end a call
 *   transfer(...)         → move a live call to another agent
 *   toggleRecording(...)  → start/stop recording mid-call
 *   fetchRecording(...)   → pull the recording bytes for storage in R2
 *   verifyWebhook(...)    → authenticate an inbound event
 *   normaliseWebhook(...) → map a provider payload to our own call shape
 *
 * With no credentials, every method returns `not_configured`. The CRM still
 * records manual call logs, notes and dispositions — it simply cannot dial.
 */

import { Provider, RESULT_STATUS, basicAuth } from './base.js';
import { hmacSha256Hex, timingSafeEqual, toBase64Url } from '../auth/crypto.js';

/** The shared shape every provider maps its payloads into. */
export const CALL_STATUS = {
  initiated: 'initiated', ringing: 'ringing', in_progress: 'in_progress',
  completed: 'completed', missed: 'missed', busy: 'busy',
  no_answer: 'no_answer', failed: 'failed', cancelled: 'cancelled', voicemail: 'voicemail',
};

class TelephonyProvider extends Provider {
  constructor(options) { super({ ...options, category: 'telephony' }); }

  /** Capabilities the UI uses to decide which controls to show. */
  get capabilities() {
    return {
      clickToCall: true, inbound: true, recording: true, transfer: false,
      conference: false, ivr: false, voicemail: false, liveStatus: true, dtmf: false,
    };
  }

  async placeCall() { return this.failure('Not implemented.', { code: 'not_implemented' }); }
  async getCall() { return this.failure('Not implemented.', { code: 'not_implemented' }); }
  async hangUp() { return this.failure('Not implemented.', { code: 'not_implemented' }); }
  async transfer() { return this.failure('This provider does not support in-call transfer.', { code: 'unsupported' }); }
  async toggleRecording() { return this.failure('This provider does not support toggling recording mid-call.', { code: 'unsupported' }); }
  async verifyWebhook() { return { valid: false, reason: 'not_implemented' }; }
  normaliseWebhook() { return null; }

  /** Download a recording the provider hosts, for storage in R2. */
  async fetchRecording(url, headers = {}) {
    if (!url) return this.failure('No recording URL was supplied.', { code: 'no_url' });
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return this.failure(`The recording could not be fetched (HTTP ${res.status}).`, { code: 'fetch_failed' });
      return this.success({
        buffer: await res.arrayBuffer(),
        contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      });
    } catch (err) {
      return this.failure(`The recording could not be fetched: ${err.message}`, { code: 'fetch_error' });
    }
  }
}

// ===========================================================================
// EXOTEL — the Integration Stack's India-first default
// ===========================================================================

export class ExotelProvider extends TelephonyProvider {
  constructor(env) {
    super({
      key: 'exotel',
      name: 'Exotel',
      requiredKeys: ['EXOTEL_SID', 'EXOTEL_API_KEY', 'EXOTEL_API_TOKEN', 'EXOTEL_CALLER_ID'],
      optionalKeys: ['EXOTEL_SUBDOMAIN', 'TELEPHONY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://developer.exotel.com/api/',
    });
  }

  get capabilities() {
    return { ...super.capabilities, transfer: true, ivr: true, voicemail: true, dtmf: true };
  }

  get baseUrl() {
    const subdomain = this.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
    return `https://${subdomain}/v1/Accounts/${this.env.EXOTEL_SID}`;
  }

  get authHeader() {
    return basicAuth(this.env.EXOTEL_API_KEY, this.env.EXOTEL_API_TOKEN);
  }

  /**
   * Exotel connects the agent first, then the customer. `from` is the agent's
   * phone, `to` the customer, and CallerId the tenant's virtual number.
   */
  async placeCall({ from, to, callerId, record = true, callbackUrl, timeLimitSeconds = 3600 }) {
    if (!this.isConfigured()) return this.notConfigured('place that call');

    const params = new URLSearchParams({
      From: from,
      To: to,
      CallerId: callerId || this.env.EXOTEL_CALLER_ID,
      CallType: 'trans',
      Record: record ? 'true' : 'false',
      TimeLimit: String(timeLimitSeconds),
    });
    if (callbackUrl) params.set('StatusCallback', callbackUrl);

    const res = await this.request(`${this.baseUrl}/Calls/connect.json`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) return this.failure(res.error, { code: 'exotel_call_failed', raw: res.body });

    const call = res.body?.Call ?? {};
    return this.success({
      providerCallId: call.Sid,
      status: mapExotelStatus(call.Status),
      from: call.From, to: call.To, direction: 'outbound',
      startedAt: call.DateCreated ? new Date(call.DateCreated).toISOString() : null,
    }, { providerId: call.Sid, raw: res.body });
  }

  async getCall(providerCallId) {
    if (!this.isConfigured()) return this.notConfigured('check that call');
    const res = await this.request(
      `${this.baseUrl}/Calls/${encodeURIComponent(providerCallId)}.json`, {
        headers: { Authorization: this.authHeader },
      });
    if (!res.ok) return this.failure(res.error, { code: 'exotel_fetch_failed', raw: res.body });

    const call = res.body?.Call ?? {};
    return this.success({
      providerCallId: call.Sid,
      status: mapExotelStatus(call.Status),
      durationSeconds: Number(call.Duration) || 0,
      recordingUrl: call.RecordingUrl ?? null,
      price: call.Price ?? null,
      startedAt: call.StartTime ? new Date(call.StartTime).toISOString() : null,
      endedAt: call.EndTime ? new Date(call.EndTime).toISOString() : null,
    }, { raw: res.body });
  }

  async hangUp(providerCallId) {
    if (!this.isConfigured()) return this.notConfigured('end that call');
    const res = await this.request(
      `${this.baseUrl}/Calls/${encodeURIComponent(providerCallId)}.json`, {
        method: 'POST',
        headers: { Authorization: this.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Status: 'completed' }).toString(),
      });
    if (!res.ok) return this.failure(res.error, { code: 'exotel_hangup_failed', raw: res.body });
    return this.success({ ended: true });
  }

  async fetchRecording(url) {
    return super.fetchRecording(url, { Authorization: this.authHeader });
  }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.TELEPHONY_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  normaliseWebhook(payload) {
    return {
      providerCallId: payload.CallSid ?? payload.Sid ?? null,
      status: mapExotelStatus(payload.Status ?? payload.CallStatus),
      direction: String(payload.Direction ?? '').includes('inbound') ? 'inbound' : 'outbound',
      from: payload.From ?? payload.CallFrom ?? null,
      to: payload.To ?? payload.CallTo ?? null,
      durationSeconds: Number(payload.Duration ?? payload.ConversationDuration) || 0,
      recordingUrl: payload.RecordingUrl ?? null,
      startedAt: payload.StartTime ? new Date(payload.StartTime).toISOString() : null,
      endedAt: payload.EndTime ? new Date(payload.EndTime).toISOString() : null,
      virtualNumber: payload.CallerId ?? payload.To ?? null,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(`${this.baseUrl}/Calls.json?PageSize=1`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'exotel_test_failed', raw: res.body });
    return this.success({ reachable: true, sid: this.env.EXOTEL_SID, callerId: this.env.EXOTEL_CALLER_ID });
  }
}

function mapExotelStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (['completed', 'complete'].includes(s)) return CALL_STATUS.completed;
  if (['in-progress', 'in_progress', 'connected'].includes(s)) return CALL_STATUS.in_progress;
  if (['ringing', 'in-call'].includes(s)) return CALL_STATUS.ringing;
  if (['busy'].includes(s)) return CALL_STATUS.busy;
  if (['no-answer', 'no_answer'].includes(s)) return CALL_STATUS.no_answer;
  if (['failed'].includes(s)) return CALL_STATUS.failed;
  if (['canceled', 'cancelled'].includes(s)) return CALL_STATUS.cancelled;
  if (['missed'].includes(s)) return CALL_STATUS.missed;
  return CALL_STATUS.initiated;
}

// ===========================================================================
// TWILIO
// ===========================================================================

export class TwilioProvider extends TelephonyProvider {
  constructor(env) {
    super({
      key: 'twilio',
      name: 'Twilio',
      requiredKeys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_CALLER_ID'],
      optionalKeys: ['TELEPHONY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://www.twilio.com/docs/voice/api',
    });
  }

  get capabilities() {
    return { ...super.capabilities, transfer: true, conference: true, ivr: true, voicemail: true, dtmf: true };
  }

  get baseUrl() {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.env.TWILIO_ACCOUNT_SID}`;
  }

  get authHeader() {
    return basicAuth(this.env.TWILIO_ACCOUNT_SID, this.env.TWILIO_AUTH_TOKEN);
  }

  async placeCall({ from, to, callerId, record = true, callbackUrl, twimlUrl }) {
    if (!this.isConfigured()) return this.notConfigured('place that call');

    const params = new URLSearchParams({
      To: to,
      From: callerId || this.env.TWILIO_CALLER_ID,
      Record: record ? 'true' : 'false',
    });
    // Twilio needs instructions for the leg; dial the agent when none given.
    params.set('Twiml', twimlUrl
      ? ''
      : `<Response><Dial callerId="${escapeXml(callerId || this.env.TWILIO_CALLER_ID)}" record="${record ? 'record-from-answer' : 'do-not-record'}">${escapeXml(from)}</Dial></Response>`);
    if (twimlUrl) { params.delete('Twiml'); params.set('Url', twimlUrl); }
    if (callbackUrl) {
      params.set('StatusCallback', callbackUrl);
      params.set('StatusCallbackEvent', 'initiated ringing answered completed');
    }

    const res = await this.request(`${this.baseUrl}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'twilio_call_failed', raw: res.body });

    return this.success({
      providerCallId: res.body.sid,
      status: mapTwilioStatus(res.body.status),
      from: res.body.from, to: res.body.to, direction: 'outbound',
      startedAt: res.body.date_created ? new Date(res.body.date_created).toISOString() : null,
    }, { providerId: res.body.sid, raw: res.body });
  }

  async getCall(providerCallId) {
    if (!this.isConfigured()) return this.notConfigured('check that call');
    const res = await this.request(`${this.baseUrl}/Calls/${encodeURIComponent(providerCallId)}.json`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'twilio_fetch_failed', raw: res.body });
    return this.success({
      providerCallId: res.body.sid,
      status: mapTwilioStatus(res.body.status),
      durationSeconds: Number(res.body.duration) || 0,
      price: res.body.price,
      startedAt: res.body.start_time ? new Date(res.body.start_time).toISOString() : null,
      endedAt: res.body.end_time ? new Date(res.body.end_time).toISOString() : null,
    }, { raw: res.body });
  }

  async hangUp(providerCallId) {
    if (!this.isConfigured()) return this.notConfigured('end that call');
    const res = await this.request(`${this.baseUrl}/Calls/${encodeURIComponent(providerCallId)}.json`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Status: 'completed' }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'twilio_hangup_failed', raw: res.body });
    return this.success({ ended: true });
  }

  async transfer({ providerCallId, to }) {
    if (!this.isConfigured()) return this.notConfigured('transfer that call');
    const res = await this.request(`${this.baseUrl}/Calls/${encodeURIComponent(providerCallId)}.json`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        Twiml: `<Response><Dial>${escapeXml(to)}</Dial></Response>`,
      }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'twilio_transfer_failed', raw: res.body });
    return this.success({ transferred: true, to });
  }

  async toggleRecording({ providerCallId, enabled }) {
    if (!this.isConfigured()) return this.notConfigured('change recording');
    if (enabled) {
      const res = await this.request(`${this.baseUrl}/Calls/${encodeURIComponent(providerCallId)}/Recordings.json`, {
        method: 'POST',
        headers: { Authorization: this.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ RecordingStatusCallbackEvent: 'completed' }).toString(),
      });
      if (!res.ok) return this.failure(res.error, { code: 'twilio_record_failed', raw: res.body });
      return this.success({ recording: true, recordingSid: res.body.sid });
    }
    return this.success({ recording: false, note: 'Recording stops when the call ends.' });
  }

  async fetchRecording(url) {
    return super.fetchRecording(url, { Authorization: this.authHeader });
  }

  /** Twilio signs the full URL plus sorted POST parameters with the auth token. */
  async verifyWebhook(rawBody, signature, url) {
    const token = this.env.TWILIO_AUTH_TOKEN;
    if (!token) return { valid: false, reason: 'missing_secret' };
    if (!signature || !url) return { valid: false, reason: 'missing_signature' };

    const params = new URLSearchParams(rawBody);
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const payload = url + sorted.map(([k, v]) => `${k}${v}`).join('');

    const { hmacSha256 } = await import('../auth/crypto.js');
    const mac = await hmacSha256(token, payload);
    const expected = btoa(String.fromCharCode(...mac));
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  normaliseWebhook(payload) {
    return {
      providerCallId: payload.CallSid ?? null,
      status: mapTwilioStatus(payload.CallStatus),
      direction: payload.Direction === 'inbound' ? 'inbound' : 'outbound',
      from: payload.From ?? null,
      to: payload.To ?? null,
      durationSeconds: Number(payload.CallDuration ?? payload.RecordingDuration) || 0,
      recordingUrl: payload.RecordingUrl ? `${payload.RecordingUrl}.mp3` : null,
      startedAt: null,
      endedAt: payload.CallStatus === 'completed' ? new Date().toISOString() : null,
      virtualNumber: payload.To ?? null,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(`${this.baseUrl}.json`, { headers: { Authorization: this.authHeader } });
    if (!res.ok) return this.failure(res.error, { code: 'twilio_test_failed', raw: res.body });
    return this.success({ reachable: true, friendlyName: res.body?.friendly_name, status: res.body?.status });
  }
}

function mapTwilioStatus(status) {
  const s = String(status ?? '').toLowerCase();
  const map = {
    queued: CALL_STATUS.initiated, initiated: CALL_STATUS.initiated,
    ringing: CALL_STATUS.ringing, 'in-progress': CALL_STATUS.in_progress,
    completed: CALL_STATUS.completed, busy: CALL_STATUS.busy,
    'no-answer': CALL_STATUS.no_answer, failed: CALL_STATUS.failed,
    canceled: CALL_STATUS.cancelled,
  };
  return map[s] ?? CALL_STATUS.initiated;
}

// ===========================================================================
// PLIVO
// ===========================================================================

export class PlivoProvider extends TelephonyProvider {
  constructor(env) {
    super({
      key: 'plivo',
      name: 'Plivo',
      requiredKeys: ['PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN', 'PLIVO_CALLER_ID'],
      optionalKeys: ['TELEPHONY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://www.plivo.com/docs/voice/api/call',
    });
  }

  get capabilities() { return { ...super.capabilities, transfer: true, conference: true, dtmf: true }; }

  get baseUrl() { return `https://api.plivo.com/v1/Account/${this.env.PLIVO_AUTH_ID}`; }
  get authHeader() { return basicAuth(this.env.PLIVO_AUTH_ID, this.env.PLIVO_AUTH_TOKEN); }

  async placeCall({ from, to, callerId, callbackUrl, answerUrl }) {
    if (!this.isConfigured()) return this.notConfigured('place that call');
    const res = await this.request(`${this.baseUrl}/Call/`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: callerId || this.env.PLIVO_CALLER_ID,
        to,
        answer_url: answerUrl || callbackUrl,
        answer_method: 'POST',
        hangup_url: callbackUrl,
      }),
    });
    if (!res.ok) return this.failure(res.error, { code: 'plivo_call_failed', raw: res.body });
    return this.success({
      providerCallId: res.body.request_uuid,
      status: CALL_STATUS.initiated, from, to, direction: 'outbound',
    }, { providerId: res.body.request_uuid, raw: res.body });
  }

  async getCall(providerCallId) {
    if (!this.isConfigured()) return this.notConfigured('check that call');
    const res = await this.request(`${this.baseUrl}/Call/${encodeURIComponent(providerCallId)}/`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'plivo_fetch_failed', raw: res.body });
    return this.success({
      providerCallId,
      status: mapPlivoStatus(res.body.call_state ?? res.body.call_status),
      durationSeconds: Number(res.body.call_duration) || 0,
      startedAt: res.body.initiation_time ? new Date(res.body.initiation_time).toISOString() : null,
      endedAt: res.body.end_time ? new Date(res.body.end_time).toISOString() : null,
    }, { raw: res.body });
  }

  async hangUp(providerCallId) {
    if (!this.isConfigured()) return this.notConfigured('end that call');
    const res = await this.request(`${this.baseUrl}/Call/${encodeURIComponent(providerCallId)}/`, {
      method: 'DELETE', headers: { Authorization: this.authHeader },
    });
    if (!res.ok && res.httpStatus !== 204) return this.failure(res.error, { code: 'plivo_hangup_failed' });
    return this.success({ ended: true });
  }

  async fetchRecording(url) { return super.fetchRecording(url, { Authorization: this.authHeader }); }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.TELEPHONY_WEBHOOK_SECRET ?? this.env.PLIVO_AUTH_TOKEN;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  normaliseWebhook(payload) {
    return {
      providerCallId: payload.CallUUID ?? payload.RequestUUID ?? null,
      status: mapPlivoStatus(payload.CallStatus ?? payload.Event),
      direction: payload.Direction === 'inbound' ? 'inbound' : 'outbound',
      from: payload.From ?? null, to: payload.To ?? null,
      durationSeconds: Number(payload.Duration) || 0,
      recordingUrl: payload.RecordUrl ?? null,
      endedAt: payload.EndTime ? new Date(payload.EndTime).toISOString() : null,
      virtualNumber: payload.To ?? null,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(`${this.baseUrl}/`, { headers: { Authorization: this.authHeader } });
    if (!res.ok) return this.failure(res.error, { code: 'plivo_test_failed', raw: res.body });
    return this.success({ reachable: true, name: res.body?.name });
  }
}

function mapPlivoStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (['completed', 'hangup'].includes(s)) return CALL_STATUS.completed;
  if (['in-progress', 'answer'].includes(s)) return CALL_STATUS.in_progress;
  if (['ringing', 'ring'].includes(s)) return CALL_STATUS.ringing;
  if (['busy'].includes(s)) return CALL_STATUS.busy;
  if (['no-answer', 'timeout'].includes(s)) return CALL_STATUS.no_answer;
  if (['failed'].includes(s)) return CALL_STATUS.failed;
  return CALL_STATUS.initiated;
}

// ===========================================================================
// KNOWLARITY
// ===========================================================================

export class KnowlarityProvider extends TelephonyProvider {
  constructor(env) {
    super({
      key: 'knowlarity',
      name: 'Knowlarity',
      requiredKeys: ['KNOWLARITY_API_KEY', 'KNOWLARITY_SR_NUMBER'],
      optionalKeys: ['TELEPHONY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://developer.knowlarity.com/',
    });
  }

  get capabilities() { return { ...super.capabilities, ivr: true, voicemail: true }; }

  async placeCall({ from, to, callbackUrl }) {
    if (!this.isConfigured()) return this.notConfigured('place that call');
    const res = await this.request('https://kpi.knowlarity.com/Basic/v1/account/call/makecall', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.env.KNOWLARITY_API_KEY,
        authorization: this.env.KNOWLARITY_API_KEY,
      },
      body: JSON.stringify({
        k_number: this.env.KNOWLARITY_SR_NUMBER,
        agent_number: from,
        customer_number: to,
        caller_id: this.env.KNOWLARITY_SR_NUMBER,
        additional_params: callbackUrl ? { callback_url: callbackUrl } : undefined,
      }),
    });
    if (!res.ok) return this.failure(res.error, { code: 'knowlarity_call_failed', raw: res.body });
    return this.success({
      providerCallId: res.body?.success?.call_id ?? res.body?.call_id ?? null,
      status: CALL_STATUS.initiated, from, to, direction: 'outbound',
    }, { raw: res.body });
  }

  async getCall() {
    return this.failure('Knowlarity reports call state by webhook rather than polling.', { code: 'webhook_only' });
  }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.TELEPHONY_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  normaliseWebhook(payload) {
    return {
      providerCallId: payload.call_id ?? payload.uuid ?? null,
      status: mapGenericStatus(payload.call_status ?? payload.status),
      direction: String(payload.call_type ?? '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound',
      from: payload.customer_number ?? payload.caller_id ?? null,
      to: payload.agent_number ?? payload.k_number ?? null,
      durationSeconds: Number(payload.duration ?? payload.call_duration) || 0,
      recordingUrl: payload.resource_url ?? payload.recording_url ?? null,
      startedAt: payload.start_time ? new Date(payload.start_time).toISOString() : null,
      endedAt: payload.end_time ? new Date(payload.end_time).toISOString() : null,
      virtualNumber: payload.k_number ?? null,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request('https://kpi.knowlarity.com/Basic/v1/account/calllog?limit=1', {
      headers: { 'x-api-key': this.env.KNOWLARITY_API_KEY, authorization: this.env.KNOWLARITY_API_KEY },
    });
    if (!res.ok) return this.failure(res.error, { code: 'knowlarity_test_failed', raw: res.body });
    return this.success({ reachable: true, srNumber: this.env.KNOWLARITY_SR_NUMBER });
  }
}

// ===========================================================================
// MYOPERATOR
// ===========================================================================

export class MyOperatorProvider extends TelephonyProvider {
  constructor(env) {
    super({
      key: 'myoperator',
      name: 'MyOperator',
      requiredKeys: ['MYOPERATOR_API_KEY', 'MYOPERATOR_COMPANY_ID'],
      optionalKeys: ['MYOPERATOR_PUBLIC_IVR', 'TELEPHONY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://developers.myoperator.com/',
    });
  }

  get capabilities() { return { ...super.capabilities, ivr: true, voicemail: true, transfer: true }; }

  async placeCall({ from, to, callbackUrl }) {
    if (!this.isConfigured()) return this.notConfigured('place that call');
    const res = await this.request('https://obd-api.myoperator.co/obd-api-v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.env.MYOPERATOR_API_KEY },
      body: JSON.stringify({
        company_id: this.env.MYOPERATOR_COMPANY_ID,
        type: '1',
        number: to,
        public_ivr_id: this.env.MYOPERATOR_PUBLIC_IVR ?? undefined,
        agent_number: from,
        callback_url: callbackUrl,
      }),
    });
    if (!res.ok) return this.failure(res.error, { code: 'myoperator_call_failed', raw: res.body });
    return this.success({
      providerCallId: res.body?.data?.unique_id ?? res.body?.unique_id ?? null,
      status: CALL_STATUS.initiated, from, to, direction: 'outbound',
    }, { raw: res.body });
  }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.TELEPHONY_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  normaliseWebhook(payload) {
    return {
      providerCallId: payload.unique_id ?? payload.call_id ?? null,
      status: mapGenericStatus(payload.status ?? payload.call_status),
      direction: String(payload.call_type ?? '').toLowerCase() === 'incoming' ? 'inbound' : 'outbound',
      from: payload.caller_number ?? payload.customer_number ?? null,
      to: payload.agent_number ?? payload.company_number ?? null,
      durationSeconds: Number(payload.duration) || 0,
      recordingUrl: payload.recording_url ?? payload.audio_url ?? null,
      endedAt: payload.end_time ? new Date(payload.end_time).toISOString() : null,
      virtualNumber: payload.company_number ?? null,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(
      `https://api.myoperator.co/company/${encodeURIComponent(this.env.MYOPERATOR_COMPANY_ID)}`, {
        headers: { 'x-api-key': this.env.MYOPERATOR_API_KEY },
      });
    if (!res.ok) return this.failure(res.error, { code: 'myoperator_test_failed', raw: res.body });
    return this.success({ reachable: true, companyId: this.env.MYOPERATOR_COMPANY_ID });
  }
}

// ===========================================================================
// RINGCENTRAL
// ===========================================================================

export class RingCentralProvider extends TelephonyProvider {
  constructor(env) {
    super({
      key: 'ringcentral',
      name: 'RingCentral',
      requiredKeys: ['RINGCENTRAL_CLIENT_ID', 'RINGCENTRAL_CLIENT_SECRET', 'RINGCENTRAL_JWT'],
      optionalKeys: ['RINGCENTRAL_SERVER', 'TELEPHONY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://developers.ringcentral.com/api-reference',
    });
  }

  get capabilities() {
    return { ...super.capabilities, transfer: true, conference: true, ivr: true, voicemail: true, dtmf: true };
  }

  get server() { return this.env.RINGCENTRAL_SERVER || 'https://platform.ringcentral.com'; }

  async #accessToken() {
    const res = await this.request(`${this.server}/restapi/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(this.env.RINGCENTRAL_CLIENT_ID, this.env.RINGCENTRAL_CLIENT_SECRET),
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.env.RINGCENTRAL_JWT,
      }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'ringcentral_token_failed', raw: res.body });
    return this.success({ token: res.body.access_token });
  }

  async placeCall({ from, to }) {
    if (!this.isConfigured()) return this.notConfigured('place that call');
    const tokenResult = await this.#accessToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.request(`${this.server}/restapi/v1.0/account/~/telephony/call-out`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResult.data.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: { phoneNumber: from }, to: { phoneNumber: to } }),
    });
    if (!res.ok) return this.failure(res.error, { code: 'ringcentral_call_failed', raw: res.body });
    return this.success({
      providerCallId: res.body?.session?.id ?? res.body?.id ?? null,
      status: CALL_STATUS.initiated, from, to, direction: 'outbound',
    }, { raw: res.body });
  }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.TELEPHONY_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  normaliseWebhook(payload) {
    const party = payload?.body?.parties?.[0] ?? {};
    return {
      providerCallId: payload?.body?.telephonySessionId ?? payload?.body?.sessionId ?? null,
      status: mapGenericStatus(party?.status?.code),
      direction: String(party.direction ?? '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound',
      from: party?.from?.phoneNumber ?? null,
      to: party?.to?.phoneNumber ?? null,
      durationSeconds: 0,
      recordingUrl: party?.recordings?.[0]?.uri ?? null,
      virtualNumber: party?.to?.phoneNumber ?? null,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const tokenResult = await this.#accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request(`${this.server}/restapi/v1.0/account/~/extension/~`, {
      headers: { Authorization: `Bearer ${tokenResult.data.token}` },
    });
    if (!res.ok) return this.failure(res.error, { code: 'ringcentral_test_failed', raw: res.body });
    return this.success({ reachable: true, extension: res.body?.extensionNumber });
  }
}

// ===========================================================================
// AIRCALL
// ===========================================================================

export class AircallProvider extends TelephonyProvider {
  constructor(env) {
    super({
      key: 'aircall',
      name: 'Aircall',
      requiredKeys: ['AIRCALL_API_ID', 'AIRCALL_API_TOKEN'],
      optionalKeys: ['TELEPHONY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://developer.aircall.io/api-references/',
    });
  }

  get capabilities() { return { ...super.capabilities, transfer: true, ivr: true, voicemail: true }; }

  get authHeader() { return basicAuth(this.env.AIRCALL_API_ID, this.env.AIRCALL_API_TOKEN); }

  async placeCall({ from, to, agentId }) {
    if (!this.isConfigured()) return this.notConfigured('place that call');
    if (!agentId) {
      return this.failure('Aircall dials from a specific user; set the agent\'s Aircall user id in Settings → Calling.', {
        code: 'missing_agent',
      });
    }
    const res = await this.request(`https://api.aircall.io/v1/users/${encodeURIComponent(agentId)}/dial`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (!res.ok) return this.failure(res.error, { code: 'aircall_call_failed', raw: res.body });
    return this.success({
      providerCallId: res.body?.call?.id ? String(res.body.call.id) : null,
      status: CALL_STATUS.initiated, from, to, direction: 'outbound',
    }, { raw: res.body });
  }

  async getCall(providerCallId) {
    if (!this.isConfigured()) return this.notConfigured('check that call');
    const res = await this.request(`https://api.aircall.io/v1/calls/${encodeURIComponent(providerCallId)}`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'aircall_fetch_failed', raw: res.body });
    const call = res.body?.call ?? {};
    return this.success({
      providerCallId: String(call.id),
      status: mapGenericStatus(call.status),
      durationSeconds: Number(call.duration) || 0,
      recordingUrl: call.recording ?? null,
      startedAt: call.started_at ? new Date(call.started_at * 1000).toISOString() : null,
      endedAt: call.ended_at ? new Date(call.ended_at * 1000).toISOString() : null,
    }, { raw: res.body });
  }

  async fetchRecording(url) { return super.fetchRecording(url, { Authorization: this.authHeader }); }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.TELEPHONY_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  normaliseWebhook(payload) {
    const call = payload?.data ?? payload?.call ?? {};
    return {
      providerCallId: call.id ? String(call.id) : null,
      status: mapGenericStatus(call.status),
      direction: call.direction === 'inbound' ? 'inbound' : 'outbound',
      from: call.raw_digits ?? call.from ?? null,
      to: call.number?.digits ?? call.to ?? null,
      durationSeconds: Number(call.duration) || 0,
      recordingUrl: call.recording ?? null,
      startedAt: call.started_at ? new Date(call.started_at * 1000).toISOString() : null,
      endedAt: call.ended_at ? new Date(call.ended_at * 1000).toISOString() : null,
      virtualNumber: call.number?.digits ?? null,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request('https://api.aircall.io/v1/ping', {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'aircall_test_failed', raw: res.body });
    return this.success({ reachable: true });
  }
}

function mapGenericStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (['answered', 'in-progress', 'in_progress', 'connected', 'active', 'answer'].includes(s)) return CALL_STATUS.in_progress;
  if (['completed', 'done', 'hangup', 'disconnected', 'finished'].includes(s)) return CALL_STATUS.completed;
  if (['ringing', 'initial', 'setup', 'proceeding'].includes(s)) return CALL_STATUS.ringing;
  if (['busy'].includes(s)) return CALL_STATUS.busy;
  if (['no-answer', 'no_answer', 'noanswer', 'missed', 'not_answered'].includes(s)) return CALL_STATUS.missed;
  if (['voicemail'].includes(s)) return CALL_STATUS.voicemail;
  if (['failed', 'error'].includes(s)) return CALL_STATUS.failed;
  if (['cancelled', 'canceled'].includes(s)) return CALL_STATUS.cancelled;
  return CALL_STATUS.initiated;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ===========================================================================

export const TELEPHONY_IMPLEMENTATIONS = {
  exotel: ExotelProvider,
  knowlarity: KnowlarityProvider,
  myoperator: MyOperatorProvider,
  twilio: TwilioProvider,
  plivo: PlivoProvider,
  ringcentral: RingCentralProvider,
  aircall: AircallProvider,
};

export function telephonyProvider(key, env) {
  const Ctor = TELEPHONY_IMPLEMENTATIONS[key];
  return Ctor ? new Ctor(env) : null;
}

/** Every provider with its connection state, for the Calling settings screen. */
export function describeTelephonyProviders(env) {
  return Object.keys(TELEPHONY_IMPLEMENTATIONS).map(key => {
    const provider = telephonyProvider(key, env);
    return { ...provider.describe(), capabilities: provider.capabilities };
  });
}

export { mapGenericStatus, escapeXml };
