/**
 * Messaging providers: email (Amazon SES), SMS (MSG91), WhatsApp (Meta Cloud
 * API) and push (Firebase Cloud Messaging) — the four vendors the Integration
 * Stack addendum selects.
 *
 * Each one performs a real API call. With no credentials configured they
 * return `not_configured`, which the notification dispatcher records against
 * the delivery row; nothing is ever logged as "sent" that was not sent.
 */

import { Provider, RESULT_STATUS, basicAuth } from './base.js';
import { toHex, hmacSha256, sha256Hex, textEncoder } from '../auth/crypto.js';

// ===========================================================================
// EMAIL — Amazon SES (SigV4 signed, no SDK)
// ===========================================================================

export class SesProvider extends Provider {
  constructor(env) {
    super({
      key: 'ses',
      name: 'Amazon SES',
      category: 'email',
      requiredKeys: ['SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_REGION', 'SES_FROM_ADDRESS'],
      optionalKeys: ['SES_FROM_NAME'],
      env,
      docsUrl: 'https://docs.aws.amazon.com/ses/latest/APIReference-V2/',
    });
  }

  get region() { return this.env.SES_REGION || 'ap-south-1'; }
  get host() { return `email.${this.region}.amazonaws.com`; }

  async send({ to, subject, text, html, replyTo, attachments = [] }) {
    if (!this.isConfigured()) return this.notConfigured('send that email');

    const recipients = Array.isArray(to) ? to : [to];
    const fromName = this.env.SES_FROM_NAME || 'Meet Millions Finance CRM';
    const from = `${fromName} <${this.env.SES_FROM_ADDRESS}>`;

    // SES v2 SendEmail with a Simple body. Attachments would require a raw
    // MIME message; the caller is told rather than silently dropping them.
    if (attachments.length) {
      return this.failure(
        'Attachments require the raw-MIME send path, which is not enabled for this account.',
        { code: 'attachments_unsupported' });
    }

    const payload = {
      FromEmailAddress: from,
      Destination: { ToAddresses: recipients },
      ReplyToAddresses: replyTo ? [replyTo] : undefined,
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
            ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
          },
        },
      },
    };

    const body = JSON.stringify(payload);
    const path = '/v2/email/outbound-emails';
    const headers = await this.#sign('POST', path, body);

    const res = await this.request(`https://${this.host}${path}`, {
      method: 'POST', headers, body,
    });

    if (!res.ok) return this.failure(res.error, { code: 'ses_error', raw: res.body, retryable: res.httpStatus >= 500 });
    return this.success({ messageId: res.body?.MessageId }, {
      status: RESULT_STATUS.SENT, providerId: res.body?.MessageId, raw: res.body,
    });
  }

  /** AWS Signature Version 4. */
  async #sign(method, path, body) {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 'ses';
    const payloadHash = await sha256Hex(body);

    const canonicalHeaders =
      `content-type:application/json\nhost:${this.host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-date';
    const canonicalRequest =
      `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const scope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign =
      `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

    const kDate = await hmacRaw(`AWS4${this.env.SES_SECRET_ACCESS_KEY}`, dateStamp);
    const kRegion = await hmacRaw(kDate, this.region);
    const kService = await hmacRaw(kRegion, service);
    const kSigning = await hmacRaw(kService, 'aws4_request');
    const signature = toHex(await hmacRaw(kSigning, stringToSign));

    return {
      'Content-Type': 'application/json',
      'X-Amz-Date': amzDate,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${this.env.SES_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const path = '/v2/email/account';
    const headers = await this.#sign('GET', path, '');
    const res = await this.request(`https://${this.host}${path}`, { method: 'GET', headers });
    if (!res.ok) return this.failure(res.error, { code: 'ses_test_failed', raw: res.body });
    return this.success({
      sendingEnabled: res.body?.SendingEnabled,
      productionAccess: res.body?.ProductionAccessEnabled,
      quota: res.body?.SendQuota,
    }, { raw: res.body });
  }
}

async function hmacRaw(key, message) {
  const keyBytes = typeof key === 'string' ? textEncoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(message)));
}

// ===========================================================================
// SMS — MSG91 (DLT registered for India)
// ===========================================================================

export class Msg91Provider extends Provider {
  constructor(env) {
    super({
      key: 'msg91',
      name: 'MSG91',
      category: 'sms',
      requiredKeys: ['MSG91_AUTH_KEY', 'MSG91_SENDER_ID'],
      optionalKeys: ['MSG91_ROUTE', 'MSG91_DLT_TE_ID'],
      env,
      docsUrl: 'https://docs.msg91.com/',
    });
  }

  async send({ to, text, templateId = null, variables = {} }) {
    if (!this.isConfigured()) return this.notConfigured('send that SMS');

    const number = String(to).replace(/^\+/, '');

    // MSG91's Flow API is the DLT-compliant path when a template id exists;
    // otherwise fall back to the plain SMS endpoint.
    if (templateId || this.env.MSG91_DLT_TE_ID) {
      const res = await this.request('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authkey: this.env.MSG91_AUTH_KEY },
        body: JSON.stringify({
          template_id: templateId || this.env.MSG91_DLT_TE_ID,
          sender: this.env.MSG91_SENDER_ID,
          short_url: '0',
          recipients: [{ mobiles: number, ...variables }],
        }),
      });
      if (!res.ok) return this.failure(res.error, { code: 'msg91_error', raw: res.body, retryable: res.httpStatus >= 500 });
      return this.success({ requestId: res.body?.request_id }, {
        status: RESULT_STATUS.SENT, providerId: res.body?.request_id, raw: res.body,
      });
    }

    const params = new URLSearchParams({
      authkey: this.env.MSG91_AUTH_KEY,
      mobiles: number,
      message: text,
      sender: this.env.MSG91_SENDER_ID,
      route: this.env.MSG91_ROUTE || '4',
      country: '91',
    });
    const res = await this.request(`https://api.msg91.com/api/sendhttp.php?${params}`, {
      method: 'GET', expectJson: false,
    });
    if (!res.ok) return this.failure(res.error, { code: 'msg91_error', raw: res.body });
    return this.success({ requestId: String(res.body).trim() }, {
      status: RESULT_STATUS.SENT, providerId: String(res.body).trim(),
    });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(
      `https://control.msg91.com/api/v5/user/balance?authkey=${encodeURIComponent(this.env.MSG91_AUTH_KEY)}&type=4`,
      { method: 'GET' });
    if (!res.ok) return this.failure(res.error, { code: 'msg91_test_failed', raw: res.body });
    return this.success({ balance: res.body }, { raw: res.body });
  }
}

// ===========================================================================
// WHATSAPP — Meta WhatsApp Cloud API
// ===========================================================================

export class WhatsAppProvider extends Provider {
  constructor(env) {
    super({
      key: 'whatsapp_cloud',
      name: 'WhatsApp Cloud API',
      category: 'whatsapp',
      requiredKeys: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
      optionalKeys: ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'],
      env,
      docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    });
  }

  get baseUrl() {
    return `https://graph.facebook.com/v21.0/${this.env.WHATSAPP_PHONE_NUMBER_ID}`;
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
    };
  }

  /**
   * Free-form text. Only valid inside the 24-hour customer-service window;
   * outside it Meta rejects the message and a template must be used instead.
   */
  async sendText({ to, text, previewUrl = false }) {
    if (!this.isConfigured()) return this.notConfigured('send that WhatsApp message');
    return this.#post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(to).replace(/^\+/, ''),
      type: 'text',
      text: { body: text, preview_url: previewUrl },
    });
  }

  /** An approved template — the only way to open a conversation. */
  async sendTemplate({ to, templateName, language = 'en', bodyParams = [], headerParams = [], buttons = [] }) {
    if (!this.isConfigured()) return this.notConfigured('send that WhatsApp template');

    const components = [];
    if (headerParams.length) {
      components.push({ type: 'header', parameters: headerParams.map(t => ({ type: 'text', text: String(t) })) });
    }
    if (bodyParams.length) {
      components.push({ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) });
    }
    for (const [index, btn] of buttons.entries()) {
      components.push({
        type: 'button', sub_type: btn.subType || 'url', index: String(index),
        parameters: [{ type: 'text', text: String(btn.value) }],
      });
    }

    return this.#post({
      messaging_product: 'whatsapp',
      to: String(to).replace(/^\+/, ''),
      type: 'template',
      template: { name: templateName, language: { code: language }, components },
    });
  }

  async sendDocument({ to, link, filename, caption }) {
    if (!this.isConfigured()) return this.notConfigured('send that document');
    return this.#post({
      messaging_product: 'whatsapp',
      to: String(to).replace(/^\+/, ''),
      type: 'document',
      document: { link, filename, caption },
    });
  }

  /** Fetch a media object a client sent, so it can be stored in R2. */
  async downloadMedia(mediaId) {
    if (!this.isConfigured()) return this.notConfigured('download that media');
    const meta = await this.request(`https://graph.facebook.com/v21.0/${mediaId}`, {
      method: 'GET', headers: { Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (!meta.ok) return this.failure(meta.error, { code: 'whatsapp_media_meta_failed', raw: meta.body });

    const fileRes = await fetch(meta.body.url, {
      headers: { Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (!fileRes.ok) return this.failure(`Media download returned HTTP ${fileRes.status}.`, { code: 'whatsapp_media_failed' });

    return this.success({
      buffer: await fileRes.arrayBuffer(),
      mimeType: meta.body.mime_type,
      sha256: meta.body.sha256,
      fileSize: meta.body.file_size,
    });
  }

  async markRead(messageId) {
    if (!this.isConfigured()) return this.notConfigured('mark that message read');
    return this.#post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
  }

  async #post(payload) {
    const res = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST', headers: this.headers, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return this.failure(res.error, {
        code: res.body?.error?.code ? `whatsapp_${res.body.error.code}` : 'whatsapp_error',
        raw: res.body,
        retryable: res.httpStatus >= 500 || res.httpStatus === 429,
      });
    }
    const id = res.body?.messages?.[0]?.id ?? null;
    return this.success({ messageId: id, contacts: res.body?.contacts }, {
      status: RESULT_STATUS.SENT, providerId: id, raw: res.body,
    });
  }

  /** Verify the X-Hub-Signature-256 header on an inbound webhook. */
  async verifyWebhook(rawBody, signatureHeader) {
    const secret = this.env.WHATSAPP_APP_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
    const provided = String(signatureHeader).replace(/^sha256=/, '');
    const expected = toHex(await hmacSha256(secret, rawBody));
    const { timingSafeEqual } = await import('../auth/crypto.js');
    return { valid: timingSafeEqual(expected, provided), reason: null };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(
      `${this.baseUrl}?fields=display_phone_number,verified_name,quality_rating`, {
        method: 'GET', headers: { Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}` },
      });
    if (!res.ok) return this.failure(res.error, { code: 'whatsapp_test_failed', raw: res.body });
    return this.success({
      phoneNumber: res.body?.display_phone_number,
      verifiedName: res.body?.verified_name,
      qualityRating: res.body?.quality_rating,
    }, { raw: res.body });
  }
}

// ===========================================================================
// PUSH — Firebase Cloud Messaging (HTTP v1, service-account JWT)
// ===========================================================================

export class FcmProvider extends Provider {
  constructor(env) {
    super({
      key: 'fcm',
      name: 'Firebase Cloud Messaging',
      category: 'push',
      requiredKeys: ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'],
      env,
      docsUrl: 'https://firebase.google.com/docs/cloud-messaging',
    });
  }

  async send({ token, title, body, data = {}, link = null }) {
    if (!this.isConfigured()) return this.notConfigured('send that push notification');

    const accessToken = await this.#accessToken();
    if (!accessToken.ok) return accessToken;

    const res = await this.request(
      `https://fcm.googleapis.com/v1/projects/${this.env.FCM_PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken.data.token}`,
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: Object.fromEntries(Object.entries({ ...data, link }).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
            android: { priority: 'HIGH' },
            apns: { headers: { 'apns-priority': '10' } },
          },
        }),
      });

    if (!res.ok) return this.failure(res.error, { code: 'fcm_error', raw: res.body, retryable: res.httpStatus >= 500 });
    return this.success({ name: res.body?.name }, { status: RESULT_STATUS.SENT, providerId: res.body?.name });
  }

  /** Exchange the service-account key for an OAuth access token. */
  async #accessToken() {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.env.FCM_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const { toBase64Url } = await import('../auth/crypto.js');
    const enc = (obj) => toBase64Url(textEncoder.encode(JSON.stringify(obj)));
    const unsigned = `${enc(header)}.${enc(claims)}`;

    let signature;
    try {
      const pem = String(this.env.FCM_PRIVATE_KEY).replace(/\\n/g, '\n');
      const key = await importPkcs8(pem);
      signature = toBase64Url(new Uint8Array(
        await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textEncoder.encode(unsigned))));
    } catch (err) {
      return this.failure(`The FCM service-account key could not be read: ${err.message}`, { code: 'fcm_bad_key' });
    }

    const res = await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'fcm_token_failed', raw: res.body });
    return this.success({ token: res.body.access_token, expiresIn: res.body.expires_in });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const token = await this.#accessToken();
    if (!token.ok) return token;
    return this.success({ project: this.env.FCM_PROJECT_ID, tokenAcquired: true });
  }
}

async function importPkcs8(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey('pkcs8', bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export { basicAuth };
