/**
 * The remaining vendor integrations: Google Sheets, Google Forms, Google and
 * Outlook Calendar, Meta Lead Ads, the e-Sign providers (Digio and Leegality)
 * and the Cloudflare DNS API used for white-label custom domains.
 */

import { Provider, RESULT_STATUS, basicAuth } from './base.js';
import { hmacSha256Hex, timingSafeEqual } from '../auth/crypto.js';

/** Shared base for the Google APIs, which all refresh the same way. */
class GoogleProvider extends Provider {
  withConnection(connection) { this.connection = connection; return this; }

  async accessToken() {
    if (!this.isConfigured()) return this.notConfigured(`reach ${this.name}`);
    if (!this.connection?.refresh_token) {
      return {
        ok: false, status: RESULT_STATUS.NOT_CONFIGURED,
        error: { code: 'not_connected', message: `No Google account is connected for ${this.name}.` },
      };
    }
    const res = await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: this.env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: this.connection.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'google_token_failed', raw: res.body });
    return this.success({ token: res.body.access_token });
  }
}

// ===========================================================================
// GOOGLE SHEETS — two-way sync
// ===========================================================================

export class GoogleSheetsProvider extends GoogleProvider {
  constructor(env) {
    super({
      key: 'google_sheets',
      name: 'Google Sheets',
      category: 'leads',
      requiredKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      env,
      docsUrl: 'https://developers.google.com/sheets/api',
    });
  }

  async readRange({ spreadsheetId, range = 'A1:Z1000' }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${tokenResult.data.token}` } });
    if (!res.ok) return this.failure(res.error, { code: 'sheets_read_failed', raw: res.body });

    const values = res.body.values ?? [];
    const [header = [], ...rows] = values;
    return this.success({
      header,
      rows: rows.map((row, index) => ({
        rowNumber: index + 2,
        cells: Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])),
      })),
      count: rows.length,
    });
  }

  async writeRange({ spreadsheetId, range, values }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokenResult.data.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
    if (!res.ok) return this.failure(res.error, { code: 'sheets_write_failed', raw: res.body });
    return this.success({ updatedCells: res.body.updatedCells, updatedRange: res.body.updatedRange });
  }

  async appendRow({ spreadsheetId, range = 'A1', values }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenResult.data.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [values] }),
      });
    if (!res.ok) return this.failure(res.error, { code: 'sheets_append_failed', raw: res.body });
    return this.success({ updates: res.body.updates });
  }

  async test() {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    return this.success({ reachable: true });
  }
}

// ===========================================================================
// GOOGLE FORMS — response capture
// ===========================================================================

export class GoogleFormsProvider extends GoogleProvider {
  constructor(env) {
    super({
      key: 'google_forms',
      name: 'Google Forms',
      category: 'leads',
      requiredKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      env,
      docsUrl: 'https://developers.google.com/forms/api',
    });
  }

  async getForm(formId) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(formId)}`, {
      headers: { Authorization: `Bearer ${tokenResult.data.token}` },
    });
    if (!res.ok) return this.failure(res.error, { code: 'forms_fetch_failed', raw: res.body });

    const questions = (res.body.items ?? [])
      .filter(i => i.questionItem)
      .map(i => ({
        id: i.questionItem.question.questionId,
        title: i.title,
        required: !!i.questionItem.question.required,
        type: Object.keys(i.questionItem.question).find(k => k.endsWith('Question')) ?? 'text',
      }));

    return this.success({ formId, title: res.body.info?.title, questions });
  }

  async listResponses({ formId, since }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const filter = since ? `?filter=${encodeURIComponent(`timestamp >= ${since}`)}` : '';
    const res = await this.request(
      `https://forms.googleapis.com/v1/forms/${encodeURIComponent(formId)}/responses${filter}`,
      { headers: { Authorization: `Bearer ${tokenResult.data.token}` } });
    if (!res.ok) return this.failure(res.error, { code: 'forms_responses_failed', raw: res.body });

    return this.success({
      responses: (res.body.responses ?? []).map(r => ({
        responseId: r.responseId,
        submittedAt: r.lastSubmittedTime,
        answers: Object.fromEntries(
          Object.entries(r.answers ?? {}).map(([qid, a]) => [
            qid, (a.textAnswers?.answers ?? []).map(x => x.value).join(', '),
          ])),
      })),
    });
  }

  async test() {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    return this.success({ reachable: true });
  }
}

// ===========================================================================
// CALENDAR — Google and Outlook
// ===========================================================================

export class GoogleCalendarProvider extends GoogleProvider {
  constructor(env) {
    super({
      key: 'google_calendar',
      name: 'Google Calendar',
      category: 'calendar',
      requiredKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      env,
      docsUrl: 'https://developers.google.com/calendar/api',
    });
  }

  async createEvent({ calendarId = 'primary', title, description, startsAt, endsAt, attendees = [], location, reminderMinutes = 30 }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;

    const res = await this.request(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenResult.data.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: title,
          description,
          location,
          start: { dateTime: startsAt, timeZone: 'Asia/Kolkata' },
          end: { dateTime: endsAt, timeZone: 'Asia/Kolkata' },
          attendees: attendees.map(email => ({ email })),
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: reminderMinutes }] },
        }),
      });
    if (!res.ok) return this.failure(res.error, { code: 'calendar_create_failed', raw: res.body });
    return this.success({ eventId: res.body.id, htmlLink: res.body.htmlLink }, { providerId: res.body.id });
  }

  async updateEvent({ calendarId = 'primary', eventId, ...patch }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenResult.data.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(patch.title ? { summary: patch.title } : {}),
          ...(patch.description ? { description: patch.description } : {}),
          ...(patch.startsAt ? { start: { dateTime: patch.startsAt, timeZone: 'Asia/Kolkata' } } : {}),
          ...(patch.endsAt ? { end: { dateTime: patch.endsAt, timeZone: 'Asia/Kolkata' } } : {}),
        }),
      });
    if (!res.ok) return this.failure(res.error, { code: 'calendar_update_failed', raw: res.body });
    return this.success({ eventId: res.body.id });
  }

  async deleteEvent({ calendarId = 'primary', eventId }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenResult.data.token}` },
        expectJson: false,
      });
    if (!res.ok && res.httpStatus !== 404 && res.httpStatus !== 410) {
      return this.failure(res.error, { code: 'calendar_delete_failed' });
    }
    return this.success({ deleted: true });
  }

  async listEvents({ calendarId = 'primary', from, to, maxResults = 250 }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const params = new URLSearchParams({
      timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime',
      maxResults: String(maxResults),
    });
    const res = await this.request(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${tokenResult.data.token}` } });
    if (!res.ok) return this.failure(res.error, { code: 'calendar_list_failed', raw: res.body });
    return this.success({
      events: (res.body.items ?? []).map(e => ({
        providerEventId: e.id, title: e.summary, description: e.description,
        startsAt: e.start?.dateTime ?? e.start?.date,
        endsAt: e.end?.dateTime ?? e.end?.date,
        location: e.location, status: e.status,
      })),
    });
  }

  async test() {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', {
      headers: { Authorization: `Bearer ${tokenResult.data.token}` },
    });
    if (!res.ok) return this.failure(res.error, { code: 'calendar_test_failed', raw: res.body });
    return this.success({ reachable: true, calendars: res.body.items?.length ?? 0 });
  }
}

export class OutlookCalendarProvider extends Provider {
  constructor(env) {
    super({
      key: 'outlook_calendar',
      name: 'Outlook Calendar',
      category: 'calendar',
      requiredKeys: ['MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET'],
      env,
      docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/calendar',
    });
  }

  withConnection(connection) { this.connection = connection; return this; }

  async accessToken() {
    if (!this.isConfigured()) return this.notConfigured('reach Outlook Calendar');
    if (!this.connection?.refresh_token) {
      return {
        ok: false, status: RESULT_STATUS.NOT_CONFIGURED,
        error: { code: 'not_connected', message: 'No Microsoft account is connected.' },
      };
    }
    const tenant = this.env.MS_GRAPH_TENANT_ID || 'common';
    const res = await this.request(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.MS_GRAPH_CLIENT_ID,
        client_secret: this.env.MS_GRAPH_CLIENT_SECRET,
        refresh_token: this.connection.refresh_token,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/.default offline_access',
      }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'msgraph_token_failed', raw: res.body });
    return this.success({ token: res.body.access_token });
  }

  async createEvent({ title, description, startsAt, endsAt, attendees = [], location }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResult.data.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: title,
        body: { contentType: 'text', content: description ?? '' },
        start: { dateTime: startsAt, timeZone: 'India Standard Time' },
        end: { dateTime: endsAt, timeZone: 'India Standard Time' },
        location: location ? { displayName: location } : undefined,
        attendees: attendees.map(email => ({ emailAddress: { address: email }, type: 'required' })),
      }),
    });
    if (!res.ok) return this.failure(res.error, { code: 'outlook_create_failed', raw: res.body });
    return this.success({ eventId: res.body.id, htmlLink: res.body.webLink }, { providerId: res.body.id });
  }

  async test() {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request('https://graph.microsoft.com/v1.0/me/calendar', {
      headers: { Authorization: `Bearer ${tokenResult.data.token}` },
    });
    if (!res.ok) return this.failure(res.error, { code: 'outlook_test_failed', raw: res.body });
    return this.success({ reachable: true, calendar: res.body?.name });
  }
}

// ===========================================================================
// META LEAD ADS
// ===========================================================================

export class MetaLeadsProvider extends Provider {
  constructor(env) {
    super({
      key: 'meta_leads',
      name: 'Meta Lead Ads',
      category: 'leads',
      requiredKeys: ['META_APP_ID', 'META_APP_SECRET', 'META_PAGE_ACCESS_TOKEN'],
      optionalKeys: ['META_LEADGEN_VERIFY_TOKEN'],
      env,
      docsUrl: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads',
    });
  }

  /** Pull a lead's field data by leadgen id, as the webhook only sends the id. */
  async fetchLead(leadgenId) {
    if (!this.isConfigured()) return this.notConfigured('fetch that lead');
    const res = await this.request(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(this.env.META_PAGE_ACCESS_TOKEN)}`);
    if (!res.ok) return this.failure(res.error, { code: 'meta_lead_failed', raw: res.body });

    const fields = Object.fromEntries(
      (res.body.field_data ?? []).map(f => [f.name, (f.values ?? []).join(', ')]));

    return this.success({
      leadgenId: res.body.id,
      createdAt: res.body.created_time,
      formId: res.body.form_id,
      campaignId: res.body.campaign_id ?? null,
      campaignName: res.body.campaign_name ?? null,
      adId: res.body.ad_id ?? null,
      platform: res.body.platform ?? 'facebook',
      fields,
      fullName: fields.full_name ?? ([fields.first_name, fields.last_name].filter(Boolean).join(' ') || null),
      email: fields.email ?? null,
      phone: fields.phone_number ?? null,
      companyName: fields.company_name ?? null,
      city: fields.city ?? null,
    });
  }

  /** Meta's X-Hub-Signature-256 over the raw body. */
  async verifyWebhook(rawBody, signatureHeader) {
    const secret = this.env.META_APP_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
    const provided = String(signatureHeader).replace(/^sha256=/, '');
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, provided), reason: null };
  }

  /** The GET handshake Meta performs when a webhook is registered. */
  verifySubscription(mode, token, challenge) {
    const expected = this.env.META_LEADGEN_VERIFY_TOKEN;
    if (!expected) return { ok: false, reason: 'missing_verify_token' };
    if (mode === 'subscribe' && token === expected) return { ok: true, challenge };
    return { ok: false, reason: 'token_mismatch' };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(
      `https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(this.env.META_PAGE_ACCESS_TOKEN)}`);
    if (!res.ok) return this.failure(res.error, { code: 'meta_test_failed', raw: res.body });
    return this.success({ reachable: true, page: res.body?.name, id: res.body?.id });
  }
}

// ===========================================================================
// E-SIGN — Digio and Leegality
// ===========================================================================

export class DigioProvider extends Provider {
  constructor(env) {
    super({
      key: 'digio',
      name: 'Digio e-Sign',
      category: 'esign',
      requiredKeys: ['DIGIO_CLIENT_ID', 'DIGIO_CLIENT_SECRET'],
      optionalKeys: ['ESIGN_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://docs.digio.in/',
    });
  }

  get baseUrl() {
    return String(this.env.APP_ENV) === 'production'
      ? 'https://api.digio.in' : 'https://ext.digio.in:444';
  }

  get authHeader() { return basicAuth(this.env.DIGIO_CLIENT_ID, this.env.DIGIO_CLIENT_SECRET); }

  async sendForSignature({ fileName, fileBase64, signers, sequential = true, displayOnPage = 'all', expiresInDays = 10 }) {
    if (!this.isConfigured()) return this.notConfigured('send that document for signature');

    const res = await this.request(`${this.baseUrl}/v2/client/document/uploadpdf`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: fileName,
        file_data: fileBase64,
        signers: signers.map((s, i) => ({
          identifier: s.email || s.phone,
          name: s.name,
          reason: s.reason ?? 'Filing sign-off',
          sign_type: s.method === 'dsc' ? 'dsc' : 'aadhaar',
          serial_number: i + 1,
        })),
        expire_in_days: expiresInDays,
        display_on_page: displayOnPage,
        notify_signers: true,
        sign_coordinates: {},
        sequential,
      }),
      timeoutMs: 45000,
    });

    if (!res.ok) return this.failure(res.error, { code: 'digio_send_failed', raw: res.body });
    return this.success({
      requestId: res.body.id,
      status: res.body.agreement_status,
      signingUrls: (res.body.signing_parties ?? []).map(p => ({
        identifier: p.identifier, status: p.status,
      })),
    }, { providerId: res.body.id, raw: res.body });
  }

  async getStatus(requestId) {
    if (!this.isConfigured()) return this.notConfigured('check that signature request');
    const res = await this.request(`${this.baseUrl}/v2/client/document/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'digio_status_failed', raw: res.body });
    return this.success({
      requestId: res.body.id,
      status: mapEsignStatus(res.body.agreement_status),
      signers: (res.body.signing_parties ?? []).map(p => ({
        identifier: p.identifier, name: p.name, status: p.status,
        signedAt: p.signed_on ?? null,
      })),
    }, { raw: res.body });
  }

  async downloadSigned(requestId) {
    if (!this.isConfigured()) return this.notConfigured('download the signed copy');
    try {
      const res = await fetch(
        `${this.baseUrl}/v2/client/document/download?document_id=${encodeURIComponent(requestId)}`,
        { headers: { Authorization: this.authHeader } });
      if (!res.ok) return this.failure(`The signed copy could not be downloaded (HTTP ${res.status}).`,
        { code: 'digio_download_failed' });
      return this.success({ buffer: await res.arrayBuffer(), contentType: 'application/pdf' });
    } catch (err) {
      return this.failure(err.message, { code: 'digio_download_error' });
    }
  }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.ESIGN_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(`${this.baseUrl}/v2/client/document/list?limit=1`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok && res.httpStatus !== 404) return this.failure(res.error, { code: 'digio_test_failed', raw: res.body });
    return this.success({ reachable: true });
  }
}

export class LeegalityProvider extends Provider {
  constructor(env) {
    super({
      key: 'leegality',
      name: 'Leegality e-Sign',
      category: 'esign',
      requiredKeys: ['LEEGALITY_AUTH_TOKEN'],
      optionalKeys: ['ESIGN_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://developer.leegality.com/',
    });
  }

  async sendForSignature({ fileName, fileBase64, signers, expiresInDays = 10 }) {
    if (!this.isConfigured()) return this.notConfigured('send that document for signature');
    const res = await this.request('https://api.leegality.com/api/v3.0/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': this.env.LEEGALITY_AUTH_TOKEN },
      body: JSON.stringify({
        profileId: 'default',
        file: { name: fileName, file: fileBase64 },
        invitees: signers.map(s => ({
          name: s.name, email: s.email, phone: s.phone,
          signatureType: s.method === 'dsc' ? ['dsc'] : ['aadhaar'],
          expiryDays: expiresInDays,
        })),
      }),
      timeoutMs: 45000,
    });
    if (!res.ok) return this.failure(res.error, { code: 'leegality_send_failed', raw: res.body });
    return this.success({
      requestId: res.body?.data?.documentId,
      status: 'sent',
      signingUrls: (res.body?.data?.invitees ?? []).map(i => ({ identifier: i.email ?? i.phone, url: i.signUrl })),
    }, { providerId: res.body?.data?.documentId, raw: res.body });
  }

  async getStatus(requestId) {
    if (!this.isConfigured()) return this.notConfigured('check that signature request');
    const res = await this.request(
      `https://api.leegality.com/api/v3.0/documents/${encodeURIComponent(requestId)}`, {
        headers: { 'X-Auth-Token': this.env.LEEGALITY_AUTH_TOKEN },
      });
    if (!res.ok) return this.failure(res.error, { code: 'leegality_status_failed', raw: res.body });
    return this.success({
      requestId,
      status: mapEsignStatus(res.body?.data?.status),
      signers: (res.body?.data?.invitees ?? []).map(i => ({
        identifier: i.email ?? i.phone, name: i.name, status: i.status, signedAt: i.signedAt ?? null,
      })),
    }, { raw: res.body });
  }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.ESIGN_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request('https://api.leegality.com/api/v3.0/profiles', {
      headers: { 'X-Auth-Token': this.env.LEEGALITY_AUTH_TOKEN },
    });
    if (!res.ok) return this.failure(res.error, { code: 'leegality_test_failed', raw: res.body });
    return this.success({ reachable: true });
  }
}

function mapEsignStatus(status) {
  const s = String(status ?? '').toLowerCase();
  if (['completed', 'signed', 'success'].includes(s)) return 'signed';
  if (['partially_signed', 'partial'].includes(s)) return 'partially_signed';
  if (['requested', 'sent', 'pending'].includes(s)) return 'sent';
  if (['declined', 'rejected'].includes(s)) return 'declined';
  if (['expired'].includes(s)) return 'expired';
  return 'sent';
}

export function esignProvider(key, env) {
  if (key === 'leegality') return new LeegalityProvider(env);
  return new DigioProvider(env);
}

// ===========================================================================
// CLOUDFLARE DNS — white-label custom domains
// ===========================================================================

export class CloudflareDnsProvider extends Provider {
  constructor(env) {
    super({
      key: 'cloudflare_dns',
      name: 'Cloudflare DNS',
      category: 'dns',
      requiredKeys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'],
      env,
      docsUrl: 'https://developers.cloudflare.com/api/',
    });
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    };
  }

  async createCname({ name, target, proxied = true }) {
    if (!this.isConfigured()) return this.notConfigured('configure that domain');
    const res = await this.request(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/dns_records`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ type: 'CNAME', name, content: target, proxied, ttl: 1 }),
      });
    if (!res.ok || res.body?.success === false) {
      return this.failure(res.error ?? res.body?.errors?.[0]?.message ?? 'Cloudflare rejected the record.', {
        code: 'cloudflare_dns_failed', raw: res.body,
      });
    }
    return this.success({ recordId: res.body.result.id, name: res.body.result.name });
  }

  async verifyDomain(hostname) {
    if (!this.isConfigured()) return this.notConfigured('verify that domain');
    const res = await this.request(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}`,
      { headers: this.headers });
    if (!res.ok) return this.failure(res.error, { code: 'cloudflare_verify_failed', raw: res.body });
    const record = res.body?.result?.[0];
    return this.success({
      found: !!record,
      proxied: record?.proxied ?? false,
      target: record?.content ?? null,
      status: record ? 'active' : 'pending_dns',
    });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(
      `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}`, { headers: this.headers });
    if (!res.ok) return this.failure(res.error, { code: 'cloudflare_test_failed', raw: res.body });
    return this.success({ reachable: true, zone: res.body?.result?.name });
  }
}

// ===========================================================================
// WEBSITE CONTACT FORM — no vendor, a signed webhook of our own
// ===========================================================================

export class WebhookFormProvider extends Provider {
  constructor(env) {
    super({
      key: 'website_form',
      name: 'Website Contact Form',
      category: 'leads',
      requiredKeys: [],   // no vendor at all — this endpoint is ours
      env,
    });
  }

  /** The snippet a tenant drops into their own site. */
  embedScript({ endpointUrl, slug }) {
    return `<!-- Meet Millions Finance CRM lead capture -->
<script>
(function () {
  var ENDPOINT = ${JSON.stringify(endpointUrl)};
  function capture(form) {
    form.addEventListener('submit', function (event) {
      var data = new FormData(form);
      var payload = { source: 'website_form', slug: ${JSON.stringify(slug)}, pageUrl: location.href };
      data.forEach(function (value, key) { payload[key] = value; });
      var utm = new URLSearchParams(location.search);
      ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(function (k) {
        if (utm.get(k)) payload[k] = utm.get(k);
      });
      // Sent alongside the normal submit so the visitor's own flow is untouched.
      navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    });
  }
  document.querySelectorAll('form[data-mm-capture]').forEach(capture);
})();
</script>`;
  }

  async test() {
    return this.success({ reachable: true, note: 'This endpoint is served by the CRM itself; no vendor is involved.' });
  }
}

export { basicAuth, mapEsignStatus };
