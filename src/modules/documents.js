/**
 * Document management: upload (single, multiple and bulk ZIP), versioning,
 * preview, download, replace, delete, comments and archival.
 *
 * Bytes live in R2 under a tenant-scoped key; metadata lives in D1. A version
 * row is immutable — replacing a document writes a new version and leaves the
 * old bytes in place, which is what makes the audit trail worth anything.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated, fileResponse } from '../http/response.js';
import {
  BadRequestError, ForbiddenError, NotFoundError, ConflictError, PayloadTooLargeError,
} from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate, sanitizeFilename } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, monthKey } from '../utils/time.js';
import { audit, auditAsync, recordActivity } from '../services/audit.js';
import { assertWithinLimit, hasFeature, bumpUsage } from '../services/features.js';
import {
  documentKey, validateUpload, limitsFor, putObject, getObject, deleteObject,
  readZipEntries, mimeFromName, signDownloadUrl, formatBytes,
} from '../services/storage.js';
import {
  assertDocumentTransition, refreshFilingPeriod, syncChecklistForDocument, slaDueAt,
} from '../services/workflow.js';
import { dispatchNotification } from '../services/notifications.js';
import { applyClientVisibility, getVisibleClient } from './clients.js';
import { queueOcr, queueAiPrecheck } from '../services/ai.js';
import { queueCloudSync } from '../services/cloud-sync.js';

const router = createRouter();
const SORTABLE = ['created_at', 'updated_at', 'title', 'status', 'priority', 'sla_due_at'];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('documents', 'd');
  where.add('d.deleted_at IS NULL');
  await applyDocumentVisibility(ctx, where);

  where.eqIf('d.client_id', ctx.q('clientId'));
  where.eqIf('d.filing_period_id', ctx.q('periodId'));
  where.eqIf('d.document_type_id', ctx.q('typeId'));
  where.eqIf('d.assigned_to', ctx.q('assignedTo'));
  where.eqIf('d.priority', ctx.q('priority'));
  where.eqIf('d.period_key', ctx.q('periodKey'));
  where.inIf('d.status', ctx.qList('status'));
  if (!ctx.qList('status').length) where.eqIf('d.status', ctx.q('status'));
  where.searchIf(['d.title', 'd.description'], ctx.q('q'));
  where.betweenIf('d.created_at', ctx.q('from'), ctx.q('to'));
  if (ctx.qBool('overdue')) where.add("d.sla_due_at < ? AND d.status IN ('submitted','under_review')", nowIso());

  const orderBy = safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), SORTABLE, 'created_at')
    .replace(/^/, 'd.');

  const joins = `
    JOIN document_types dt ON dt.id = d.document_type_id
    JOIN clients c ON c.id = d.client_id`;

  const { rows, total } = await scope.paginate('documents', where, {
    columns: `d.*, dt.name AS type_name, dt.category AS type_category, dt.key AS type_key,
              c.display_name AS client_name, c.client_code`,
    joins, alias: 'd', orderBy, page, pageSize,
  });

  return paginated(rows.map(toDocument), { page, pageSize, total }, ctx);
}, { anyPermission: ['documents.view', 'documents.view.own'] });

// ---------------------------------------------------------------------------
// Read one — with versions, comments and queries
// ---------------------------------------------------------------------------
router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await getVisibleDocument(ctx, scope, ctx.params.id);

  const versions = await scope.raw(
    `SELECT dv.*, u.full_name AS uploaded_by_name
       FROM document_versions dv
       LEFT JOIN users u ON u.id = dv.uploaded_by
      WHERE dv.tenant_id = ? AND dv.document_id = ?
      ORDER BY dv.version_no DESC`, [ctx.tenantId, document.id]);

  const commentWhere = ctx.isClient ? "AND dc.visibility = 'shared'" : '';
  const comments = await scope.raw(
    `SELECT dc.*, u.full_name AS author_name, u.avatar_key AS author_avatar
       FROM document_comments dc
       LEFT JOIN users u ON u.id = dc.author_id
      WHERE dc.tenant_id = ? AND dc.document_id = ? AND dc.deleted_at IS NULL ${commentWhere}
      ORDER BY dc.created_at ASC`, [ctx.tenantId, document.id]);

  const verifications = ctx.isClient ? [] : await scope.raw(
    `SELECT vr.*, u.full_name AS verifier_name
       FROM verification_records vr
       LEFT JOIN users u ON u.id = vr.verifier_id
      WHERE vr.tenant_id = ? AND vr.document_id = ?
      ORDER BY vr.created_at DESC`, [ctx.tenantId, document.id]);

  const queries = await scope.all('queries', { document_id: document.id }, { order: 'created_at DESC' });
  const type = await scope.rawOne(
    'SELECT * FROM document_types WHERE id = ?', [document.document_type_id]);
  const client = await scope.first('clients', { id: document.client_id },
    'id, display_name, client_code, primary_contact_name');

  const ocr = await scope.rawOne(
    'SELECT * FROM ocr_extractions WHERE tenant_id = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1',
    [ctx.tenantId, document.id]);
  const aiCheck = await scope.rawOne(
    'SELECT * FROM ai_verifications WHERE tenant_id = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1',
    [ctx.tenantId, document.id]);

  return ok({
    document: toDocument(document),
    type,
    client,
    versions,
    comments,
    verifications,
    queries,
    ocr: ocr ? { ...ocr, fields: safeJson(ocr.fields_json, []) } : null,
    aiCheck: aiCheck ? {
      ...aiCheck,
      checks: safeJson(aiCheck.checks_json, []),
      flags: safeJson(aiCheck.flags_json, []),
    } : null,
    permissions: {
      canVerify: ctx.has('documents.verify') && !document.is_locked,
      canReplace: ctx.has('documents.replace') && !document.is_locked,
      canDelete: ctx.has('documents.delete') && !document.is_locked,
      canComment: ctx.has('documents.comment'),
      canAddInternalNote: ctx.has('documents.note.internal'),
      canLock: ctx.has('documents.lock'),
      canDownload: ctx.has('documents.download'),
    },
  }, { ctx });
}, { anyPermission: ['documents.view', 'documents.view.own'] });

// ---------------------------------------------------------------------------
// Upload — multipart. Handles single files, several files and a ZIP archive.
// ---------------------------------------------------------------------------
router.post('/upload', async (ctx) => {
  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const form = await ctx.formData();

  const clientId = form.get('clientId');
  const documentTypeId = form.get('documentTypeId');
  const filingPeriodId = form.get('filingPeriodId') || null;
  const title = form.get('title');
  const description = form.get('description');
  const note = form.get('note');

  if (!clientId) throw new BadRequestError('Choose the client this upload belongs to.');
  const client = await getVisibleClient(ctx, scope, String(clientId));

  const files = form.getAll('files').filter(f => typeof f === 'object' && 'arrayBuffer' in f);
  if (!files.length) throw new BadRequestError('Attach at least one file.');

  const limits = limitsFor(ctx.env);
  if (files.length > limits.maxFilesPerUpload) {
    throw new PayloadTooLargeError(limits.maxFilesPerUpload,
      `You can upload ${limits.maxFilesPerUpload} files at a time. Use a ZIP archive for more.`);
  }

  // Plan limits: monthly upload count and total storage.
  await assertWithinLimit(ctx, 'uploads', files.length);
  const incomingBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  await assertWithinLimit(ctx, 'storage_bytes', incomingBytes);

  const period = filingPeriodId
    ? await scope.first('filing_periods', { id: filingPeriodId, client_id: client.id })
    : await currentPeriodFor(scope, client);

  const results = { created: [], skipped: [], failed: [], batch: null };

  for (const file of files) {
    const isZip = /\.zip$/i.test(file.name) ||
      ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'].includes(file.type);

    if (isZip) {
      const batchResult = await ingestZip(ctx, scope, db, {
        file, client, period, limits, note,
      });
      results.batch = batchResult.batch;
      results.created.push(...batchResult.created);
      results.skipped.push(...batchResult.skipped);
      results.failed.push(...batchResult.failed);
      continue;
    }

    try {
      const doc = await ingestFile(ctx, scope, db, {
        file, client, period,
        documentTypeId: documentTypeId ? String(documentTypeId) : null,
        title: files.length === 1 && title ? String(title) : null,
        description: description ? String(description) : null,
        note: note ? String(note) : null,
        limits,
      });
      results.created.push(doc);
    } catch (err) {
      results.failed.push({ fileName: file.name, reason: err.expose ? err.message : 'Upload failed.' });
    }
  }

  if (period) await refreshFilingPeriod(scope, period.id);
  if (results.created.length) {
    await bumpUsage(ctx, 'uploads', results.created.length);
  }

  if (results.created.length) {
    const executives = [client.assigned_executive_id, client.assigned_manager_id].filter(Boolean);
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'document.uploaded',
      userIds: executives,
      clientId: client.id,
      entityType: 'document',
      entityId: results.created[0].id,
      variables: {
        clientName: client.display_name,
        documentTitle: results.created.length === 1
          ? results.created[0].title
          : `${results.created.length} documents`,
        period: period?.period_key ?? '',
      },
      link: { path: `/verification?clientId=${client.id}` },
    }));
  }

  return created({
    ...results,
    summary: {
      uploaded: results.created.length,
      skipped: results.skipped.length,
      failed: results.failed.length,
    },
  }, { ctx });
}, { permission: 'documents.upload', rateLimit: 'documents.upload' });

/** Store one file as a new document with version 1. */
async function ingestFile(ctx, scope, db, {
  file, client, period, documentTypeId, title, description, note, limits, batchId = null, source = 'portal',
}) {
  const fileName = sanitizeFilename(file.name);
  const mimeType = file.type || mimeFromName(fileName);
  const validated = validateUpload({ fileName, mimeType, sizeBytes: file.size, limits });

  const typeId = documentTypeId ?? await inferDocumentType(scope, db, fileName);
  const type = await scope.rawOne('SELECT * FROM document_types WHERE id = ?', [typeId]);
  if (!type) throw new BadRequestError('Choose a valid document type.');

  const documentId = ID.document();
  const versionId = ID.version();
  const key = documentKey({
    tenantId: ctx.tenantId,
    companyId: client.company_id,
    clientId: client.id,
    documentId,
    versionId,
    fileName: validated.fileName,
  });

  const stored = await putObject(ctx.env, key, await file.arrayBuffer(), {
    contentType: validated.mimeType,
    fileName: validated.fileName,
    metadata: { tenantId: ctx.tenantId, clientId: client.id, documentId, versionId },
  });

  const document = await scope.insert('documents', {
    id: documentId,
    company_id: client.company_id,
    client_id: client.id,
    filing_period_id: period?.id ?? null,
    document_type_id: typeId,
    title: title || `${type.name}${period ? ` — ${period.period_key}` : ''}`,
    description: description ?? null,
    period_key: period?.period_key ?? monthKey(),
    current_version_id: versionId,
    version_count: 1,
    status: 'submitted',
    priority: 'normal',
    assigned_to: client.assigned_executive_id ?? null,
    source,
    from_zip_batch_id: batchId,
    ocr_status: 'none',
    ai_precheck_status: 'none',
    sla_due_at: slaDueAt(client.sla_hours ?? 48),
    submitted_at: nowIso(),
    created_by: ctx.userId,
  });

  await scope.insert('document_versions', {
    id: versionId,
    document_id: documentId,
    version_no: 1,
    storage_key: key,
    file_name: validated.fileName,
    mime_type: validated.mimeType,
    size_bytes: stored.size,
    checksum_sha256: stored.checksum,
    uploaded_by: ctx.userId,
    upload_note: note ?? null,
    is_current: 1,
    scan_status: 'clean',
  });

  await syncChecklistForDocument(scope, document);

  await audit(ctx, {
    action: 'documents.uploaded', category: 'documents',
    entityType: 'document', entityId: documentId, entityLabel: document.title,
    newValue: { fileName: validated.fileName, sizeBytes: stored.size, type: type.key, clientId: client.id },
  });

  await recordActivity(ctx, {
    clientId: client.id, companyId: client.company_id,
    verb: 'uploaded', entityType: 'document', entityId: documentId,
    summary: `${ctx.user?.full_name ?? 'A client'} uploaded ${document.title}`,
    detail: { fileName: validated.fileName, size: formatBytes(stored.size) },
    visibility: 'client', icon: 'upload',
  });

  // AI modules are opt-in add-ons; queueing is a no-op when they are inactive.
  if (await hasFeature(ctx, 'ocr_ai')) ctx.defer(queueOcr(ctx, scope, document, type));
  if (await hasFeature(ctx, 'ai_doc_verification')) ctx.defer(queueAiPrecheck(ctx, scope, document));

  return {
    ...toDocument(document),
    typeKey: type.key,
    typeName: type.name,
    typeCategory: type.category,
    fileName: validated.fileName,
    sizeBytes: stored.size,
  };
}

/** Expand a ZIP and ingest each entry, recording a batch report. */
async function ingestZip(ctx, scope, db, { file, client, period, limits, note }) {
  const batchId = ID.batch();
  const archiveName = sanitizeFilename(file.name);

  const batch = await scope.insert('upload_batches', {
    id: batchId,
    client_id: client.id,
    filing_period_id: period?.id ?? null,
    kind: 'zip',
    archive_name: archiveName,
    total_entries: 0,
    status: 'processing',
    created_by: ctx.userId,
  });

  const created = [];
  const skipped = [];
  const failed = [];

  try {
    const buffer = await file.arrayBuffer();
    const { entryCount, files } = await readZipEntries(buffer, { maxEntries: limits.maxZipEntries });

    for (const entry of files) {
      if (entry.skipped) { skipped.push({ fileName: entry.name, reason: entry.error }); continue; }

      const mimeType = mimeFromName(entry.name);
      try {
        validateUpload({ fileName: entry.name, mimeType, sizeBytes: entry.size, limits });
      } catch (err) {
        skipped.push({ fileName: entry.name, reason: err.message });
        continue;
      }

      const pseudoFile = {
        name: entry.name,
        type: mimeType,
        size: entry.size,
        arrayBuffer: async () => entry.content.buffer.slice(
          entry.content.byteOffset, entry.content.byteOffset + entry.content.byteLength),
      };

      try {
        const doc = await ingestFile(ctx, scope, db, {
          file: pseudoFile, client, period,
          documentTypeId: null, title: null, description: null, note,
          limits, batchId, source: 'zip',
        });
        created.push(doc);
      } catch (err) {
        failed.push({ fileName: entry.name, reason: err.expose ? err.message : 'Could not store this file.' });
      }
    }

    await scope.update('upload_batches', batchId, {
      total_entries: entryCount,
      extracted_count: created.length,
      skipped_count: skipped.length,
      failed_count: failed.length,
      status: failed.length === 0 ? (skipped.length ? 'partial' : 'completed') : 'partial',
      report_json: JSON.stringify({ created: created.map(c => c.title), skipped, failed }),
      completed_at: nowIso(),
    });

    await audit(ctx, {
      action: 'documents.uploaded', category: 'documents',
      entityType: 'upload_batch', entityId: batchId, entityLabel: archiveName,
      newValue: { entries: entryCount, extracted: created.length, skipped: skipped.length, failed: failed.length },
    });
  } catch (err) {
    await scope.update('upload_batches', batchId, {
      status: 'failed',
      report_json: JSON.stringify({ error: err.message }),
      completed_at: nowIso(),
    });
    throw err;
  }

  const finalBatch = await scope.first('upload_batches', { id: batchId });
  return { batch: finalBatch, created, skipped, failed };
}

/** Best-effort document type from the filename; falls back to "Other". */
async function inferDocumentType(scope, db, fileName) {
  const name = fileName.toLowerCase();
  const hints = [
    [/gstr[\s_-]?1/, 'gstr1'],
    [/gstr[\s_-]?3b/, 'gstr3b'],
    [/gstr[\s_-]?2[ab]/, 'gstr2a_2b'],
    [/(sales|outward).*(register)/, 'sales_register'],
    [/(purchase|inward).*(register)/, 'purchase_register'],
    [/sales|invoice.*out/, 'sales_bills'],
    [/purchase|vendor/, 'purchase_bills'],
    [/bank|statement|passbook/, 'bank_statements'],
    [/expense|petty/, 'expense_bills'],
    [/payment|receipt|utr|neft|rtgs/, 'payment_proofs'],
    [/tds.*challan|challan.*tds/, 'tds_challans'],
    [/tds|24q|26q/, 'tds_documents'],
    [/payroll|salary|pf|esi/, 'payroll_files'],
    [/form[\s_-]?16/, 'form16'],
    [/pan/, 'pan_card'],
    [/aadhaar|aadhar/, 'aadhaar'],
    [/invoice|bill/, 'invoices'],
  ];

  for (const [pattern, key] of hints) {
    if (pattern.test(name)) {
      const row = await db.one(
        `SELECT id FROM document_types WHERE key = ? AND (tenant_id = ? OR tenant_id IS NULL)
          ORDER BY (tenant_id IS NULL) ASC LIMIT 1`, [key, scope.tenantId]);
      if (row) return row.id;
    }
  }

  const fallback = await db.one(
    `SELECT id FROM document_types WHERE key = 'other' AND tenant_id IS NULL LIMIT 1`);
  return fallback?.id ?? null;
}

// ---------------------------------------------------------------------------
// Replace — a new version of an existing document
// ---------------------------------------------------------------------------
router.post('/:id/versions', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await getVisibleDocument(ctx, scope, ctx.params.id);

  if (document.is_locked) {
    throw new ForbiddenError('This document is locked because it has been verified. Ask your finance team to unlock it before replacing the file.');
  }

  const form = await ctx.formData();
  const file = form.get('file');
  const note = form.get('note');
  const resolvesQueryId = form.get('queryId');

  if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) {
    throw new BadRequestError('Attach the corrected file.');
  }

  const limits = limitsFor(ctx.env);
  const fileName = sanitizeFilename(file.name);
  const validated = validateUpload({
    fileName, mimeType: file.type || mimeFromName(fileName), sizeBytes: file.size, limits,
  });
  await assertWithinLimit(ctx, 'storage_bytes', validated.sizeBytes);

  const client = await scope.first('clients', { id: document.client_id });
  const versionNo = (document.version_count ?? 1) + 1;
  const versionId = ID.version();
  const key = documentKey({
    tenantId: ctx.tenantId,
    companyId: document.company_id,
    clientId: document.client_id,
    documentId: document.id,
    versionId,
    fileName: validated.fileName,
  });

  const stored = await putObject(ctx.env, key, await file.arrayBuffer(), {
    contentType: validated.mimeType, fileName: validated.fileName,
    metadata: { tenantId: ctx.tenantId, documentId: document.id, versionId },
  });

  await scope.updateWhere('document_versions', { document_id: document.id }, { is_current: 0 });

  const version = await scope.insert('document_versions', {
    id: versionId,
    document_id: document.id,
    version_no: versionNo,
    storage_key: key,
    file_name: validated.fileName,
    mime_type: validated.mimeType,
    size_bytes: stored.size,
    checksum_sha256: stored.checksum,
    uploaded_by: ctx.userId,
    upload_note: note ? String(note) : null,
    replaces_version_id: document.current_version_id,
    is_current: 1,
    scan_status: 'clean',
  });

  // A replacement re-enters review: a corrected file is not a verified file.
  const nextStatus = ['query_raised', 'awaiting_client', 'rejected'].includes(document.status)
    ? 'submitted'
    : (document.status === 'verified' || document.status === 'approved' ? 'under_review' : document.status);

  await scope.update('documents', document.id, {
    current_version_id: versionId,
    version_count: versionNo,
    status: nextStatus,
    verified_by: null,
    verified_at: null,
    rejected_reason: null,
    sla_due_at: slaDueAt(client?.sla_hours ?? 48),
    submitted_at: nowIso(),
  });

  const refreshed = await scope.first('documents', { id: document.id });
  await syncChecklistForDocument(scope, refreshed);
  if (refreshed.filing_period_id) await refreshFilingPeriod(scope, refreshed.filing_period_id);

  // Replacing a file in answer to a query moves that query along.
  if (resolvesQueryId) {
    const query = await scope.first('queries', { id: String(resolvesQueryId) });
    if (query && query.client_id === document.client_id) {
      await scope.update('queries', query.id, {
        status: 'client_responded',
        reply_count: (query.reply_count ?? 0) + 1,
      });
      await scope.insert('query_replies', {
        id: ID.reply(),
        query_id: query.id,
        author_id: ctx.userId,
        author_role: ctx.roleKeys[0],
        body: note ? String(note) : 'Corrected document uploaded.',
        visibility: 'shared',
        attachments_json: JSON.stringify([{ documentId: document.id, versionId, fileName: validated.fileName }]),
        channel: 'portal',
      });
    }
  }

  await audit(ctx, {
    action: 'documents.replaced', category: 'documents',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    oldValue: { versionNo: document.version_count, status: document.status },
    newValue: { versionNo, status: nextStatus, fileName: validated.fileName },
  });

  await recordActivity(ctx, {
    clientId: document.client_id, companyId: document.company_id,
    verb: 'replaced', entityType: 'document', entityId: document.id,
    summary: `${ctx.user.full_name} uploaded version ${versionNo} of ${document.title}`,
    visibility: 'client', icon: 'refresh-cw',
  });

  if (client?.assigned_executive_id) {
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'query.client_replied',
      userId: client.assigned_executive_id,
      clientId: client.id,
      entityType: 'document', entityId: document.id,
      variables: {
        clientName: client.display_name,
        documentTitle: document.title,
        reference: resolvesQueryId ? String(resolvesQueryId) : '',
        subject: document.title,
        body: note ? String(note) : 'Corrected document uploaded.',
        link: `${ctx.env.APP_URL || ''}/verification/${document.id}`,
      },
      link: { path: `/verification/${document.id}` },
    }));
  }

  return created({ version, document: toDocument(refreshed) }, { ctx });
}, { permission: 'documents.replace' });

// ---------------------------------------------------------------------------
// Download / preview
// ---------------------------------------------------------------------------
router.get('/:id/download', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await getVisibleDocument(ctx, scope, ctx.params.id);

  const versionId = ctx.q('versionId') || document.current_version_id;
  const version = await scope.first('document_versions', { id: versionId, document_id: document.id });
  if (!version) throw new NotFoundError('Document version');

  const object = await getObject(ctx.env, version.storage_key);
  const download = ctx.qBool('download');

  auditAsync(ctx, {
    action: 'documents.downloaded', category: 'documents',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    metadata: { versionNo: version.version_no, download },
  });

  return fileResponse(object.body, {
    contentType: version.mime_type,
    fileName: version.file_name,
    download,
  });
}, { permission: 'documents.download' });

/** A short-lived signed link, for sharing into an email or WhatsApp message. */
router.post('/:id/share-link', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await getVisibleDocument(ctx, scope, ctx.params.id);
  const version = await scope.first('document_versions',
    { id: document.current_version_id, document_id: document.id });
  if (!version) throw new NotFoundError('Document version');

  const body = await ctx.body();
  const input = validate(body, { expiresInMinutes: { type: 'int', min: 1, max: 1440, default: 15 } });

  const url = await signDownloadUrl(ctx.env, {
    key: version.storage_key,
    tenantId: ctx.tenantId,
    expiresInSeconds: input.expiresInMinutes * 60,
    fileName: version.file_name,
  });

  auditAsync(ctx, {
    action: 'documents.downloaded', category: 'documents', severity: 'notice',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    metadata: { sharedLink: true, expiresInMinutes: input.expiresInMinutes },
  });

  return ok({ url, expiresInMinutes: input.expiresInMinutes, fileName: version.file_name }, { ctx });
}, { permission: 'documents.download' });

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
router.post('/:id/comments', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await getVisibleDocument(ctx, scope, ctx.params.id);

  const body = await ctx.body();
  const input = validate(body, {
    body: { type: 'text', required: true, max: 5000 },
    visibility: { type: 'enum', values: ['shared', 'internal'], default: 'shared' },
    versionId: { type: 'id' },
    anchor: { type: 'json' },
  });

  if (input.visibility === 'internal' && !ctx.has('documents.note.internal')) {
    throw new ForbiddenError('You do not have permission to add internal notes.');
  }

  const comment = await scope.insert('document_comments', {
    id: ID.comment(),
    document_id: document.id,
    version_id: input.versionId ?? document.current_version_id,
    author_id: ctx.userId,
    body: input.body,
    visibility: input.visibility,
    anchor_json: input.anchor ? JSON.stringify(input.anchor) : null,
  });

  await recordActivity(ctx, {
    clientId: document.client_id, companyId: document.company_id,
    verb: 'commented', entityType: 'document', entityId: document.id,
    summary: `${ctx.user.full_name} commented on ${document.title}`,
    visibility: input.visibility === 'internal' ? 'internal' : 'client',
    icon: 'message-square',
  });

  return created({ ...comment, author_name: ctx.user.full_name }, { ctx });
}, { permission: 'documents.comment' });

// ---------------------------------------------------------------------------
// Lock / unlock / archive / delete
// ---------------------------------------------------------------------------
router.post('/:id/lock', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await scope.getOrFail('documents', ctx.params.id, { resource: 'Document' });
  const body = await ctx.body();
  const input = validate(body, { locked: { type: 'boolean', default: true } });

  if (input.locked && document.status !== 'verified' && document.status !== 'approved') {
    throw new BadRequestError('Only a verified document can be locked.');
  }

  await scope.update('documents', document.id, {
    is_locked: input.locked ? 1 : 0,
    locked_by: input.locked ? ctx.userId : null,
    locked_at: input.locked ? nowIso() : null,
  });

  await scope.insert('verification_records', {
    id: ID.verification(),
    document_id: document.id,
    version_id: document.current_version_id,
    verifier_id: ctx.userId,
    decision: input.locked ? 'locked' : 'unlocked',
    notes: null,
  });

  await audit(ctx, {
    action: 'documents.locked', category: 'documents', severity: 'notice',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    oldValue: { locked: !!document.is_locked }, newValue: { locked: input.locked },
  });

  const updated = await scope.first('documents', { id: document.id });
  return ok({ document: toDocument(updated) }, { ctx });
}, { permission: 'documents.lock' });

router.post('/:id/archive', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await scope.getOrFail('documents', ctx.params.id, { resource: 'Document' });
  assertDocumentTransition(document.status, 'archived');

  await scope.update('documents', document.id, { status: 'archived', is_locked: 1, locked_at: nowIso() });

  await audit(ctx, {
    action: 'documents.archived', category: 'documents',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    oldValue: { status: document.status }, newValue: { status: 'archived' },
  });

  if (document.filing_period_id) await refreshFilingPeriod(scope, document.filing_period_id);
  const updated = await scope.first('documents', { id: document.id });
  return ok({ document: toDocument(updated) }, { ctx });
}, { permission: 'documents.archive' });

router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await getVisibleDocument(ctx, scope, ctx.params.id);

  if (document.is_locked) {
    throw new ForbiddenError('A locked document cannot be deleted. Unlock it first.');
  }
  if (['verified', 'approved', 'archived'].includes(document.status) && !ctx.has('documents.archive')) {
    throw new ForbiddenError('A verified document can only be archived, not deleted.');
  }
  // A client may withdraw their own upload only while it is untouched.
  if (ctx.isClient && !['draft', 'submitted'].includes(document.status)) {
    throw new ForbiddenError('This document is already being reviewed and can no longer be withdrawn.');
  }

  await scope.update('documents', document.id, { deleted_at: nowIso() });

  await audit(ctx, {
    action: 'documents.deleted', category: 'documents', severity: 'warning',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    oldValue: { status: document.status, versionCount: document.version_count },
  });

  await recordActivity(ctx, {
    clientId: document.client_id, verb: 'deleted', entityType: 'document', entityId: document.id,
    summary: `${ctx.user.full_name} removed ${document.title}`,
    visibility: 'client', icon: 'trash-2',
  });

  if (document.filing_period_id) await refreshFilingPeriod(scope, document.filing_period_id);
  return ok({ deleted: true, id: document.id }, { ctx });
}, { permission: 'documents.delete' });

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------
router.get('/types/list', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const rows = await db.many(
    `SELECT * FROM document_types
      WHERE (tenant_id = ? OR tenant_id IS NULL) AND is_active = 1
      ORDER BY sort_order, name`, [ctx.tenantId]);
  return ok(rows, { ctx });
}, { anyPermission: ['documents.view', 'documents.view.own', 'documents.upload'] });

// ---------------------------------------------------------------------------

async function applyDocumentVisibility(ctx, where) {
  if (ctx.has('documents.view')) return true;
  if (ctx.has('documents.view.own') || ctx.isClient) {
    const db = new Db(ctx.env.DB);
    const { loadClientIdsForUser } = await import('../auth/identity.js');
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) { where.add('1 = 0'); return false; }
    where.inIf('d.client_id', ids);
    return true;
  }
  throw new ForbiddenError('You do not have permission to view documents.');
}

export async function getVisibleDocument(ctx, scope, documentId) {
  const document = await scope.first('documents', { id: documentId });
  if (!document || document.deleted_at) throw new NotFoundError('Document');

  if (!ctx.has('documents.view')) {
    const db = new Db(ctx.env.DB);
    const { loadClientIdsForUser } = await import('../auth/identity.js');
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.includes(document.client_id)) throw new NotFoundError('Document');
  }
  return document;
}

async function currentPeriodFor(scope, client) {
  return scope.rawOne(
    `SELECT * FROM filing_periods
      WHERE tenant_id = ? AND client_id = ? AND status NOT IN ('archived','filed')
      ORDER BY period_key DESC LIMIT 1`, [scope.tenantId, client.id]);
}

export function toDocument(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    clientCode: row.client_code ?? null,
    filingPeriodId: row.filing_period_id,
    documentTypeId: row.document_type_id,
    typeName: row.type_name ?? null,
    typeCategory: row.type_category ?? null,
    typeKey: row.type_key ?? null,
    title: row.title,
    description: row.description,
    periodKey: row.period_key,
    currentVersionId: row.current_version_id,
    versionCount: row.version_count,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assigned_to,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    rejectedReason: row.rejected_reason,
    isLocked: !!row.is_locked,
    lockedAt: row.locked_at,
    source: row.source,
    ocrStatus: row.ocr_status,
    aiPrecheckStatus: row.ai_precheck_status,
    aiConfidence: row.ai_confidence,
    slaDueAt: row.sla_due_at,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as documentsRouter };
