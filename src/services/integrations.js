/**
 * The integration registry.
 *
 * One place that knows every vendor the product can talk to, which add-on owns
 * it, what credentials it needs, and whether those credentials are present.
 * The Integrations screen renders straight from this, and a connection test
 * performs a real round trip rather than reporting a guess.
 */

import { SesProvider, Msg91Provider, WhatsAppProvider, FcmProvider } from '../integrations/messaging.js';
import { VisionOcrProvider, SpeechProvider, ClaudeProvider } from '../integrations/ai.js';
import { GoogleDriveProvider, DropboxProvider, OneDriveProvider } from '../integrations/cloud-storage.js';
import { VirusScanProvider } from '../integrations/antivirus.js';
import {
  GoogleSheetsProvider, GoogleFormsProvider, GoogleCalendarProvider, OutlookCalendarProvider,
  MetaLeadsProvider, DigioProvider, LeegalityProvider, CloudflareDnsProvider, WebhookFormProvider,
} from '../integrations/workspace.js';
import { PAYMENT_PROVIDERS, describePaymentProviders } from '../integrations/payments.js';
import { TELEPHONY_IMPLEMENTATIONS, describeTelephonyProviders } from '../integrations/telephony.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { decryptString } from '../auth/crypto.js';
import { NotFoundError } from '../http/errors.js';

/**
 * Every provider, with the add-on that owns it and the category it belongs to.
 * `oauth` means the tenant must connect an account, not just supply a key.
 */
export const PROVIDER_REGISTRY = [
  { key: 'ses',              Ctor: SesProvider,            addOn: 'email_automation',        category: 'email',     label: 'Email' },
  { key: 'msg91',            Ctor: Msg91Provider,          addOn: 'sms_automation',          category: 'sms',       label: 'SMS' },
  { key: 'whatsapp_cloud',   Ctor: WhatsAppProvider,       addOn: 'whatsapp_business_api',   category: 'whatsapp',  label: 'WhatsApp' },
  { key: 'fcm',              Ctor: FcmProvider,            addOn: 'mobile_app',              category: 'push',      label: 'Push notifications' },
  { key: 'google_vision',    Ctor: VisionOcrProvider,      addOn: 'ai_ocr_engine',           category: 'ocr',       label: 'OCR' },
  { key: 'google_speech',    Ctor: SpeechProvider,         addOn: 'voice_notes_to_crm',      category: 'speech',    label: 'Speech-to-text' },
  { key: 'anthropic',        Ctor: ClaudeProvider,         addOn: 'ai_gst_tax_assistant',    category: 'llm',       label: 'AI assistant' },
  { key: 'google_drive',     Ctor: GoogleDriveProvider,    addOn: 'google_drive',            category: 'storage',   label: 'Google Drive',  oauth: 'google' },
  { key: 'dropbox',          Ctor: DropboxProvider,        addOn: 'dropbox',                 category: 'storage',   label: 'Dropbox',       oauth: 'dropbox' },
  { key: 'onedrive',         Ctor: OneDriveProvider,       addOn: 'onedrive',                category: 'storage',   label: 'OneDrive',      oauth: 'microsoft' },
  { key: 'google_sheets',    Ctor: GoogleSheetsProvider,   addOn: 'google_sheets',           category: 'leads',     label: 'Google Sheets', oauth: 'google' },
  { key: 'google_forms',     Ctor: GoogleFormsProvider,    addOn: 'google_forms',            category: 'leads',     label: 'Google Forms',  oauth: 'google' },
  { key: 'google_calendar',  Ctor: GoogleCalendarProvider, addOn: 'calendar_integration',    category: 'calendar',  label: 'Google Calendar', oauth: 'google' },
  { key: 'outlook_calendar', Ctor: OutlookCalendarProvider,addOn: 'calendar_integration',    category: 'calendar',  label: 'Outlook Calendar', oauth: 'microsoft' },
  { key: 'meta_leads',       Ctor: MetaLeadsProvider,      addOn: 'meta_lead_ads',           category: 'leads',     label: 'Meta Lead Ads' },
  { key: 'website_form',     Ctor: WebhookFormProvider,    addOn: 'website_contact_form',    category: 'leads',     label: 'Website forms' },
  { key: 'digio',            Ctor: DigioProvider,          addOn: 'esign',                   category: 'esign',     label: 'Digio e-Sign' },
  { key: 'leegality',        Ctor: LeegalityProvider,      addOn: 'esign',                   category: 'esign',     label: 'Leegality e-Sign' },
  { key: 'cloudflare_dns',   Ctor: CloudflareDnsProvider,  addOn: 'white_label_branding',    category: 'dns',       label: 'Custom domains' },
  // Not an add-on: every deployment uploads files, so scanning belongs to the
  // core. Unconfigured it reports Not Connected, which is what it is.
  { key: 'virus_scan',       Ctor: VirusScanProvider,      addOn: null,                      category: 'security',  label: 'Upload scanning' },
];

/** Payments and telephony have their own multi-provider selectors. */
export const PAYMENT_KEYS = Object.keys(PAYMENT_PROVIDERS);
export const TELEPHONY_KEYS = Object.keys(TELEPHONY_IMPLEMENTATIONS);

export function buildProvider(key, env) {
  const entry = PROVIDER_REGISTRY.find(p => p.key === key);
  if (entry) return new entry.Ctor(env);
  if (PAYMENT_PROVIDERS[key]) return new PAYMENT_PROVIDERS[key](env);
  if (TELEPHONY_IMPLEMENTATIONS[key]) return new TELEPHONY_IMPLEMENTATIONS[key](env);
  return null;
}

/** A provider with the tenant's OAuth connection attached, where it needs one. */
export async function providerWithConnection(ctx, key) {
  const provider = buildProvider(key, ctx.env);
  if (!provider) return null;

  const entry = PROVIDER_REGISTRY.find(p => p.key === key);
  if (!entry?.oauth || typeof provider.withConnection !== 'function') return provider;

  const scope = scopeFor(ctx);
  const connection = await scope.rawOne(
    `SELECT * FROM oauth_connections WHERE tenant_id = ? AND provider = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`, [ctx.tenantId, entry.oauth]);

  if (connection?.refresh_token_enc) {
    const refresh = await decryptString(connection.refresh_token_enc, ctx.env.ENCRYPTION_KEY || ctx.env.AUTH_SECRET);
    provider.withConnection({ ...connection, refresh_token: refresh });
  }
  return provider;
}

/**
 * Describe every integration for the settings screen: what it is, whether its
 * credentials are present, whether the owning add-on is active, and the last
 * test result recorded against it.
 */
export async function describeAllIntegrations(ctx) {
  const db = new Db(ctx.env.DB);

  const stored = ctx.tenantId
    ? await db.many('SELECT * FROM integrations WHERE tenant_id = ?', [ctx.tenantId])
    : [];
  const byProvider = new Map(stored.map(s => [s.provider, s]));

  const activeAddOns = ctx.tenantId
    ? await db.many(
        `SELECT a.key FROM add_on_subscriptions s JOIN add_ons a ON a.id = s.add_on_id
          WHERE s.tenant_id = ? AND s.status IN ('active','trialing')`, [ctx.tenantId])
    : [];
  const activeKeys = new Set(activeAddOns.map(a => a.key));

  const connections = ctx.tenantId
    ? await db.many(
        `SELECT provider, account_email, status, expires_at FROM oauth_connections
          WHERE tenant_id = ? AND status = 'active'`, [ctx.tenantId])
    : [];
  const byOauth = new Map(connections.map(c => [c.provider, c]));

  const describe = (key, meta) => {
    const provider = buildProvider(key, ctx.env);
    if (!provider) return null;
    const base = provider.describe();
    const record = byProvider.get(key);
    const oauthKind = meta?.oauth ?? null;
    const oauthConnection = oauthKind ? byOauth.get(oauthKind) : null;

    // "Connected" needs both the platform credentials and, where relevant,
    // a linked account. Anything short of that reports as not connected.
    //
    // A provider with no required keys is not a vendor we connect to at all —
    // the website form is served by this Worker. Calling that "connected"
    // would put a green tick against something no one has set up, so it gets
    // its own status and is left out of the connected count.
    const selfHosted = (base.requiredKeys ?? []).length === 0 && !oauthKind;
    const connected = !selfHosted && base.configured && (!oauthKind || !!oauthConnection);

    return {
      ...base,
      label: meta?.label ?? base.name,
      addOn: meta?.addOn ?? null,
      addOnActive: meta?.addOn ? activeKeys.has(meta.addOn) : true,
      oauth: oauthKind,
      account: oauthConnection?.account_email ?? null,
      selfHosted,
      status: selfHosted ? 'self_hosted' : (connected ? 'connected' : 'not_connected'),
      needsAccountLink: !!oauthKind && !oauthConnection,
      lastTestAt: record?.last_test_at ?? null,
      lastTestOk: record?.last_test_ok === null || record?.last_test_ok === undefined
        ? null : !!record.last_test_ok,
      lastTestMessage: record?.last_test_message ?? null,
      lastSyncAt: record?.last_sync_at ?? null,
      config: safeJson(record?.config_json, {}),
    };
  };

  const core = PROVIDER_REGISTRY.map(meta => describe(meta.key, meta)).filter(Boolean);

  const payments = describePaymentProviders(ctx.env).map(p => ({
    ...p,
    label: 'Payments',
    addOn: 'payment_gateway',
    addOnActive: activeKeys.has('payment_gateway'),
    status: p.configured ? 'connected' : 'not_connected',
  }));

  const telephony = describeTelephonyProviders(ctx.env).map(p => ({
    ...p,
    label: 'Cloud telephony',
    addOn: 'cloud_telephony',
    addOnActive: activeKeys.has('cloud_telephony') || activeKeys.has('cloud_calling_system'),
    status: p.configured ? 'connected' : 'not_connected',
  }));

  return [...core, ...payments, ...telephony];
}

/** Run a real connection test and record the outcome. */
export async function testIntegration(ctx, key) {
  const provider = await providerWithConnection(ctx, key);
  if (!provider) throw new NotFoundError('Integration', `No integration named "${key}".`);

  const started = Date.now();
  const result = await provider.test();
  const durationMs = Date.now() - started;

  if (ctx.tenantId) {
    const scope = scopeFor(ctx);
    const existing = await scope.first('integrations', { provider: key });
    const patch = {
      last_test_at: nowIso(),
      last_test_ok: result.ok ? 1 : 0,
      last_test_message: result.ok
        ? 'Connection verified.'
        : (result.error?.message ?? 'The connection test failed.').slice(0, 500),
      status: patchStatus(result),
      last_error: result.ok ? null : (result.error?.message ?? null),
    };

    if (existing) {
      await scope.update('integrations', existing.id, patch);
    } else {
      const meta = PROVIDER_REGISTRY.find(p => p.key === key);
      await scope.insert('integrations', {
        id: ID.integration(),
        provider: key,
        category: provider.category,
        add_on_key: meta?.addOn ?? null,
        display_name: provider.name,
        credential_ref: JSON.stringify(provider.requiredKeys),
        connected_by: ctx.userId,
        connected_at: result.ok ? nowIso() : null,
        ...patch,
      });
    }
  }

  return {
    provider: key,
    name: provider.name,
    ok: result.ok,
    // The provider's own verdict, kept intact. Collapsing `not_configured`
    // into a generic failure would send someone hunting for a fault when the
    // answer is "nobody has added the keys yet".
    status: result.status,
    // What the integration row now says, which is a smaller vocabulary.
    connectionStatus: patchStatus(result),
    configured: provider.isConfigured(),
    missingKeys: provider.missingKeys(),
    message: result.ok
      ? `${provider.name} responded successfully.`
      : (result.error?.message ?? 'The connection test failed.'),
    details: result.ok ? result.data : null,
    durationMs,
  };
}

function patchStatus(result) {
  if (result.ok) return 'connected';
  return result.status === 'not_configured' ? 'not_connected' : 'error';
}

/** Record a sync run against an integration, for the Sync Log screens. */
export async function logSync(scope, {
  provider, integrationId = null, direction = 'inbound', operation,
  status, recordsIn = 0, recordsOut = 0, recordsFailed = 0,
  detail = null, errorMessage = null, startedAt, durationMs = null,
}) {
  return scope.insert('integration_sync_logs', {
    id: ID.syncLog(),
    integration_id: integrationId,
    provider,
    direction,
    operation,
    status,
    records_in: recordsIn,
    records_out: recordsOut,
    records_failed: recordsFailed,
    detail_json: detail ? JSON.stringify(detail) : null,
    error_message: errorMessage ? String(errorMessage).slice(0, 1000) : null,
    duration_ms: durationMs,
    started_at: startedAt ?? nowIso(),
    finished_at: nowIso(),
  });
}

/** Ensure an `integrations` row exists for a provider, and return it. */
export async function ensureIntegration(ctx, key, patch = {}) {
  const scope = scopeFor(ctx);
  const existing = await scope.first('integrations', { provider: key });
  if (existing) {
    if (Object.keys(patch).length) await scope.update('integrations', existing.id, patch);
    return scope.first('integrations', { id: existing.id });
  }

  const provider = buildProvider(key, ctx.env);
  const meta = PROVIDER_REGISTRY.find(p => p.key === key);

  return scope.insert('integrations', {
    id: ID.integration(),
    provider: key,
    category: provider?.category ?? 'other',
    add_on_key: meta?.addOn ?? null,
    display_name: provider?.name ?? key,
    status: provider?.isConfigured() ? 'connected' : 'not_connected',
    credential_ref: JSON.stringify(provider?.requiredKeys ?? []),
    connected_by: ctx.userId,
    ...patch,
  });
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { describePaymentProviders, describeTelephonyProviders };
