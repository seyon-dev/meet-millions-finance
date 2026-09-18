/**
 * File serving.
 *
 * R2 is private. Bytes leave the system through exactly two doors: an
 * authenticated request whose permissions are checked against the owning
 * record, or a signed URL that carries its own expiry and HMAC. There is no
 * public bucket and no guessable key.
 *
 * Mounted at /files/* rather than /api/*, because these responses are binary
 * and are linked directly from <img>, <audio> and download attributes.
 */

import { createRouter } from '../http/router.js';
import { fileResponse } from '../http/response.js';
import { NotFoundError, AppError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { getObject, verifySignedUrl, mimeFromName } from '../services/storage.js';
import { auditAsync } from '../services/audit.js';
import { loadClientIdsForUser } from '../auth/identity.js';

const router = createRouter();

/**
 * A signed URL. No session is required — the signature is the authorisation,
 * which is what makes these usable in an <img> tag or an email.
 */
router.get('/signed', async (ctx) => {
  // Throws a ForbiddenError naming the exact problem — expired, tampered, or
  // pointing outside its own tenant's prefix.
  const verified = await verifySignedUrl(ctx.env, ctx.query);

  const object = await getObject(ctx.env, verified.key);
  if (!object) throw new NotFoundError('File');

  return fileResponse(object.body, {
    contentType: object.httpMetadata?.contentType ?? mimeFromName(verified.fileName ?? verified.key),
    fileName: verified.fileName ?? verified.key.split('/').pop(),
    download: verified.disposition === 'attachment',
    cacheSeconds: 300,
  });
}, { auth: false });

/**
 * An authenticated fetch of a document version's bytes.
 *
 * The permission decision is made against the document row, not the key, so a
 * user who has the key but not the document still gets a 404.
 */
router.get('/documents/:documentId', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await scope.first('documents', { id: ctx.params.documentId });
  if (!document || document.deleted_at) throw new NotFoundError('Document');

  await assertMaySeeDocument(ctx, document);

  const versionId = ctx.q('versionId');
  const version = versionId
    ? await scope.first('document_versions', { id: versionId, document_id: document.id })
    : await scope.first('document_versions', { id: document.current_version_id });
  if (!version || !version.storage_key) throw new NotFoundError('File');

  const object = await getObject(ctx.env, version.storage_key);
  if (!object) {
    // The row says there is a file but the bucket disagrees. Say so plainly —
    // a silent empty response would look like a corrupt download.
    throw new AppError('The stored file could not be read. Please re-upload this document.', {
      status: 502, code: 'object_missing', expose: true,
    });
  }

  const download = ctx.qBool('download');
  if (download) {
    auditAsync(ctx, {
      action: 'documents.downloaded', category: 'documents',
      entityType: 'document', entityId: document.id, entityLabel: document.title,
      metadata: { versionId: version.id },
    });
  }

  return fileResponse(object.body, {
    contentType: version.mime_type ?? mimeFromName(version.file_name),
    fileName: version.file_name,
    download,
    cacheSeconds: 0, // documents are permissioned; never cache them at the edge
  });
}, { auth: true });

/** Tenant assets — logos, avatars, white-label artwork. */
router.get('/assets/:kind/:id', async (ctx) => {
  const { kind, id } = ctx.params;
  const allowed = new Set(['logo', 'avatar', 'favicon', 'letterhead', 'signature']);
  if (!allowed.has(kind)) throw new NotFoundError('Asset');

  const scope = scopeFor(ctx);
  const key = await resolveAssetKey(ctx, scope, kind, id);
  if (!key) throw new NotFoundError('Asset');

  const object = await getObject(ctx.env, key);
  if (!object) throw new NotFoundError('Asset');

  return fileResponse(object.body, {
    contentType: object.httpMetadata?.contentType ?? mimeFromName(key),
    fileName: key.split('/').pop(),
    download: false,
    // Assets are not confidential and change rarely, so they may be cached.
    cacheSeconds: 3600,
  });
}, { auth: true });

async function resolveAssetKey(ctx, scope, kind, id) {
  if (kind === 'avatar') {
    const user = await scope.first('users', { id });
    return user?.avatar_key ?? null;
  }
  if (kind === 'logo') {
    const company = await scope.first('companies', { id });
    if (company?.logo_key) return company.logo_key;
    const branding = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
    return branding?.logo_key ?? null;
  }
  const branding = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
  return branding?.[`${kind}_key`] ?? null;
}

/**
 * Who may read a document.
 *
 * Staff read within their tenant; a client reads only documents belonging to
 * a client record they are attached to. Both paths raise 404 rather than 403,
 * so a probe cannot confirm that a document id exists.
 */
async function assertMaySeeDocument(ctx, document) {
  if (ctx.isClient) {
    const db = new Db(ctx.env.DB);
    const clientIds = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!clientIds.includes(document.client_id)) throw new NotFoundError('Document');
    return;
  }
  if (!ctx.has('documents.view') && !ctx.has('documents.view.own')) {
    throw new NotFoundError('Document');
  }
  if (!ctx.has('documents.view') && document.uploaded_by !== ctx.userId
      && document.assigned_to !== ctx.userId) {
    throw new NotFoundError('Document');
  }
}

export { router as filesRouter };
