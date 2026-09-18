/**
 * Mirroring verified documents into a tenant's own cloud storage.
 *
 * A sync item is queued when a document reaches the configured trigger state
 * (upload, verified or approved). The queue is drained here and retried by the
 * daily cron, so a provider outage delays the copy rather than losing it.
 */

import { Db } from '../db/client.js';
import { TenantScope } from '../db/tenancy.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { getObject } from './storage.js';
import { storageProvider } from '../integrations/cloud-storage.js';
import { decryptString } from '../auth/crypto.js';
import { sanitizeFilename } from '../utils/validate.js';

/**
 * Queue a document for every folder map whose trigger matches.
 * Returns the queued items; an inactive add-on simply yields none.
 */
export async function queueCloudSync(ctx, scope, document, { trigger = 'verified' } = {}) {
  const maps = await scope.raw(
    `SELECT m.* FROM storage_folder_maps m
       JOIN integrations i ON i.id = m.integration_id
      WHERE m.tenant_id = ? AND m.auto_sync = 1 AND m.sync_on = ?
        AND i.status = 'connected'`, [scope.tenantId, trigger]);

  const queued = [];
  for (const map of maps) {
    if (!appliesTo(map, document)) continue;
    queued.push(await scope.insert('storage_sync_items', {
      id: ID.syncItem(),
      map_id: map.id,
      document_id: document.id,
      version_id: document.current_version_id,
      status: 'pending',
    }));
  }
  return queued;
}

function appliesTo(map, document) {
  if (map.scope_type === 'tenant') return true;
  if (map.scope_type === 'company') return map.scope_id === document.company_id;
  if (map.scope_type === 'client') return map.scope_id === document.client_id;
  return false;
}

/** Push one queued item to its provider. */
export async function syncItem(env, scope, item) {
  const map = await scope.first('storage_folder_maps', { id: item.map_id });
  if (!map) {
    await scope.update('storage_sync_items', item.id, { status: 'skipped', error_message: 'Folder mapping was removed.' });
    return { ok: false, skipped: true };
  }

  const document = await scope.first('documents', { id: item.document_id });
  const version = await scope.first('document_versions', { id: item.version_id ?? document?.current_version_id });
  if (!document || !version) {
    await scope.update('storage_sync_items', item.id, { status: 'skipped', error_message: 'Document or version no longer exists.' });
    return { ok: false, skipped: true };
  }

  const connection = await scope.first('oauth_connections', { integration_id: map.integration_id });
  const provider = storageProvider(map.provider, env);
  if (!provider) {
    await scope.update('storage_sync_items', item.id, { status: 'failed', error_message: `Unknown provider: ${map.provider}` });
    return { ok: false };
  }

  if (connection?.refresh_token_enc) {
    const refresh = await decryptString(connection.refresh_token_enc, env.ENCRYPTION_KEY || env.AUTH_SECRET);
    provider.withConnection({ ...connection, refresh_token: refresh });
  }

  await scope.update('storage_sync_items', item.id, { status: 'syncing' });

  try {
    const client = await scope.first('clients', { id: document.client_id });
    const company = await scope.first('companies', { id: document.company_id });
    const folderPath = buildFolderPath(map.remote_path, { company, client, document });

    const object = await getObject(env, version.storage_key);
    const result = await provider.uploadFile({
      folderPath,
      fileName: sanitizeFilename(version.file_name),
      mimeType: version.mime_type,
      bytes: new Uint8Array(await object.arrayBuffer()),
    });

    if (!result.ok) {
      await scope.update('storage_sync_items', item.id, {
        status: 'failed',
        error_message: result.error?.message ?? 'Upload failed.',
      });
      return { ok: false, error: result.error };
    }

    await scope.update('storage_sync_items', item.id, {
      status: 'synced',
      remote_file_id: result.data.fileId,
      remote_path: result.data.path ? `${result.data.path}/${version.file_name}` : folderPath,
      synced_at: nowIso(),
      error_message: null,
    });
    await scope.update('storage_folder_maps', map.id, { last_sync_at: nowIso() });

    return { ok: true, remoteFileId: result.data.fileId };
  } catch (err) {
    await scope.update('storage_sync_items', item.id, { status: 'failed', error_message: err.message });
    return { ok: false, error: { message: err.message } };
  }
}

/** Substitute {company}, {client}, {period} and {year} into a path template. */
export function buildFolderPath(template, { company, client, document }) {
  const period = document?.period_key ?? '';
  return String(template || 'Meet Millions CRM')
    .replace(/\{company\}/gi, safeSegment(company?.name))
    .replace(/\{client\}/gi, safeSegment(client?.display_name))
    .replace(/\{clientCode\}/gi, safeSegment(client?.client_code))
    .replace(/\{period\}/gi, safeSegment(period))
    .replace(/\{year\}/gi, safeSegment(period.slice(0, 4)))
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
    .join('/');
}

function safeSegment(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'Unsorted';
}

/** Drain pending and previously failed items. Called by the daily cron. */
export async function retryPendingSyncs(env, { limit = 100 } = {}) {
  const db = new Db(env.DB);
  const items = await db.many(
    `SELECT * FROM storage_sync_items
      WHERE status IN ('pending','failed') ORDER BY created_at ASC LIMIT ?`, [limit]);

  let synced = 0, failed = 0, skipped = 0;
  for (const item of items) {
    const scope = new TenantScope(db, item.tenant_id);
    const result = await syncItem(env, scope, item);
    if (result.ok) synced++;
    else if (result.skipped) skipped++;
    else failed++;
  }
  return { attempted: items.length, synced, failed, skipped };
}
