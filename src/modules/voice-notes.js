/**
 * Voice notes (add-on 4 — Voice Notes to CRM).
 *
 * An executive on a call, or standing in a client's office, records a few
 * seconds of audio instead of typing. It is attached to the client — and
 * optionally to the exact document, query or task being discussed — and, where
 * speech-to-text is configured, transcribed so the note is searchable rather
 * than something somebody has to listen to.
 *
 * Transcription is a separate, honest state on the row: `not_configured` when
 * no speech credentials exist on this deployment, `failed` when the provider
 * refused. The recording is kept and playable either way — a note that cannot
 * be transcribed is still the note.
 */

import { createRouter } from '../http/router.js';
import { ok, paginated, fileResponse } from '../http/response.js';
import { BadRequestError, NotFoundError, ForbiddenError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { sanitizeFilename } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { loadClientIdsForUser } from '../auth/identity.js';
import {
  tenantAssetKey, validateUpload, putObject, getObject, deleteObject, formatBytes,
} from '../services/storage.js';
import { assertFeature } from '../services/features.js';
import { transcribeVoiceNote } from '../services/ai.js';
import { audit, recordActivity } from '../services/audit.js';

const router = createRouter();

/**
 * Audio only, and much smaller than a document.
 *
 * Documents allow PDFs and spreadsheets; a voice note allows none of that.
 * Keeping the two lists apart means widening one never quietly widens the
 * other.
 */
const AUDIO_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  allowedMime: [
    'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
    'audio/x-wav', 'audio/aac', 'audio/m4a', 'audio/x-m4a',
  ],
  allowedExtensions: ['webm', 'ogg', 'oga', 'mp3', 'm4a', 'mp4', 'wav', 'aac'],
  blockedExtensions: ['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'dll', 'js', 'vbs', 'ps1', 'sh', 'jar', 'app', 'apk', 'html', 'htm', 'svg', 'php'],
  maxFilesPerUpload: 1,
  maxZipEntries: 0,
};

const ENTITY_TYPES = ['client', 'document', 'query', 'task'];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const { page, pageSize } = ctx.pagination({ defaultSize: 25, maxSize: 100 });

  const where = scope.where('voice_notes', 'v');
  where.eqIf('v.client_id', ctx.q('clientId'));
  where.eqIf('v.entity_type', ctx.q('entityType'));
  where.eqIf('v.entity_id', ctx.q('entityId'));
  where.eqIf('v.author_id', ctx.q('authorId'));
  where.searchIf(['v.transcript'], ctx.q('q'));

  // A client hears only notes recorded against their own record. Internal
  // notes about a client are not notes for the client, so this endpoint is
  // staff-only by permission; the narrowing below is belt and braces.
  if (ctx.isClient) {
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) return paginated([], { page, pageSize, total: 0 }, ctx);
    where.inIf('v.client_id', ids);
  } else if (!ctx.has('clients.view') && ctx.has('clients.view.assigned')) {
    where.add(`(v.author_id = ? OR v.client_id IN (
      SELECT id FROM clients WHERE tenant_id = ?
        AND (assigned_executive_id = ? OR assigned_manager_id = ?)))`,
      ctx.userId, ctx.tenantId, ctx.userId, ctx.userId);
  }

  const { rows, total } = await scope.paginate('voice_notes', where, {
    columns: 'v.*, c.display_name AS client_name, c.client_code, u.full_name AS author_name',
    joins: `LEFT JOIN clients c ON c.id = v.client_id
            LEFT JOIN users u ON u.id = v.author_id`,
    alias: 'v',
    orderBy: 'v.created_at DESC',
    page, pageSize,
  });

  return paginated(rows.map(toVoiceNote), { page, pageSize, total }, ctx);
}, { anyPermission: ['voicenotes.create', 'clients.view', 'clients.view.assigned'] });

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------
router.post('/', async (ctx) => {
  await assertFeature(ctx, 'voice_notes');

  const scope = scopeFor(ctx);
  const form = await ctx.formData();
  const file = form.get('audio');

  if (!file || typeof file === 'string') {
    throw new BadRequestError('Attach the recording as the "audio" field.');
  }

  const input = validate({
    clientId: form.get('clientId') || null,
    entityType: form.get('entityType') || null,
    entityId: form.get('entityId') || null,
    durationSeconds: form.get('durationSeconds') || 0,
    transcribe: form.get('transcribe') ?? 'true',
  }, {
    clientId: { type: 'id', required: false },
    entityType: { type: 'enum', values: ENTITY_TYPES, required: false },
    entityId: { type: 'id', required: false },
    durationSeconds: { type: 'int', min: 0, max: 3600, default: 0 },
    transcribe: { type: 'boolean', default: true },
  });

  if (input.entityType && !input.entityId) {
    throw new BadRequestError('Say which record this note is about, or leave the type off.');
  }

  // A note has to hang off something findable, or it is lost the moment it is
  // recorded.
  if (!input.clientId && !input.entityId) {
    throw new BadRequestError('A voice note needs a client or a record to attach to.');
  }

  let client = null;
  if (input.clientId) {
    client = await scope.first('clients', { id: input.clientId });
    if (!client) throw new NotFoundError('Client');
  }

  const fileName = sanitizeFilename(file.name || `voice-note-${Date.now()}.webm`);
  const validated = validateUpload({
    fileName,
    mimeType: (file.type || '').split(';')[0] || 'audio/webm',
    sizeBytes: file.size,
    limits: AUDIO_LIMITS,
  });

  const id = ID.voiceNote();
  const key = tenantAssetKey({
    tenantId: ctx.tenantId, kind: 'voice-notes', id, fileName: validated.fileName,
  });
  const stored = await putObject(ctx.env, key, await file.arrayBuffer(), {
    contentType: validated.mimeType,
    fileName: validated.fileName,
    metadata: { tenantId: ctx.tenantId, voiceNoteId: id },
  });

  const row = await scope.insert('voice_notes', {
    id,
    client_id: client?.id ?? null,
    entity_type: input.entityType ?? (client ? 'client' : null),
    entity_id: input.entityId ?? client?.id ?? null,
    author_id: ctx.userId,
    storage_key: key,
    mime_type: validated.mimeType,
    duration_seconds: input.durationSeconds,
    size_bytes: stored.size,
    transcript_status: input.transcribe ? 'pending' : 'skipped',
    created_at: nowIso(),
  });

  await audit(ctx, {
    action: 'voicenotes.recorded', category: 'communication',
    entityType: 'voice_note', entityId: id,
    entityLabel: client?.display_name ?? input.entityId,
    newValue: { sizeBytes: stored.size, durationSeconds: input.durationSeconds, mimeType: validated.mimeType },
  });

  if (client) {
    await recordActivity(ctx, {
      clientId: client.id, companyId: client.company_id,
      verb: 'noted', entityType: 'voice_note', entityId: id,
      summary: `${ctx.user?.full_name ?? 'Someone'} recorded a voice note (${formatDuration(input.durationSeconds)})`,
      icon: 'mic',
    });
  }

  // Transcription runs after the response: the person who recorded the note
  // should not wait on a speech API to get their upload confirmed.
  let transcription = null;
  if (input.transcribe) {
    transcription = await transcribeVoiceNote(ctx, scope, row);
  }

  const saved = await scope.first('voice_notes', { id });
  return ok({
    voiceNote: toVoiceNote({ ...saved, client_name: client?.display_name ?? null, author_name: ctx.user?.full_name ?? null }),
    transcription: transcription
      ? {
          attempted: true,
          configured: transcription.configured,
          missingKeys: transcription.missingKeys ?? [],
          error: transcription.error?.message ?? null,
        }
      : { attempted: false, configured: null, missingKeys: [], error: null },
    sizeLabel: formatBytes(stored.size),
  }, { ctx, status: 201 });
}, { permission: 'voicenotes.create', rateLimit: 'documents.upload' });

// ---------------------------------------------------------------------------
// One note, its audio, and a retry
// ---------------------------------------------------------------------------
router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const row = await loadVisible(ctx, scope, ctx.params.id);
  return ok({ voiceNote: toVoiceNote(row) }, { ctx });
}, { anyPermission: ['voicenotes.create', 'clients.view', 'clients.view.assigned'] });

router.get('/:id/audio', async (ctx) => {
  const scope = scopeFor(ctx);
  const row = await loadVisible(ctx, scope, ctx.params.id);
  const object = await getObject(ctx.env, row.storage_key);
  return fileResponse(object.body, {
    contentType: row.mime_type,
    fileName: `voice-note-${row.id}.${extensionFor(row.mime_type)}`,
    download: ctx.qBool('download'),
  });
}, { anyPermission: ['voicenotes.create', 'clients.view', 'clients.view.assigned'] });

/**
 * Try the transcript again.
 *
 * The case this exists for is real: a note recorded before speech credentials
 * were added is otherwise stuck at `not_configured` for ever.
 */
router.post('/:id/transcribe', async (ctx) => {
  await assertFeature(ctx, 'voice_notes');
  const scope = scopeFor(ctx);
  const row = await loadVisible(ctx, scope, ctx.params.id);

  const result = await transcribeVoiceNote(ctx, scope, row);
  const saved = await scope.first('voice_notes', { id: row.id });

  return ok({
    voiceNote: toVoiceNote(saved),
    configured: result.configured,
    missingKeys: result.missingKeys ?? [],
    error: result.error?.message ?? null,
  }, { ctx });
}, { permission: 'voicenotes.create' });

router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const row = await loadVisible(ctx, scope, ctx.params.id);

  // Somebody else's note is not yours to remove unless you manage the team.
  // `clients.assign` is the manager-and-above line; executives do not hold it.
  if (row.author_id !== ctx.userId && !ctx.has('clients.assign')) {
    throw new ForbiddenError('Only the person who recorded this note, or a manager, can delete it.');
  }

  await deleteObject(ctx.env, row.storage_key);
  await scope.delete('voice_notes', row.id);

  await audit(ctx, {
    action: 'voicenotes.deleted', category: 'communication',
    entityType: 'voice_note', entityId: row.id,
    oldValue: { clientId: row.client_id, createdAt: row.created_at },
  });

  return ok({ id: row.id, removed: true }, { ctx });
}, { anyPermission: ['voicenotes.create', 'clients.assign'] });

// ---------------------------------------------------------------------------

async function loadVisible(ctx, scope, id) {
  const row = await scope.rawOne(
    `SELECT v.*, c.display_name AS client_name, c.client_code, u.full_name AS author_name
       FROM voice_notes v
       LEFT JOIN clients c ON c.id = v.client_id
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.id = ? AND v.tenant_id = ?`, [id, ctx.tenantId]);
  if (!row) throw new NotFoundError('Voice note');

  if (ctx.isClient) {
    const ids = await loadClientIdsForUser(new Db(ctx.env.DB), ctx.userId, ctx.tenantId);
    if (!row.client_id || !ids.includes(row.client_id)) throw new NotFoundError('Voice note');
  }
  return row;
}

function toVoiceNote(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    clientCode: row.client_code ?? null,
    entityType: row.entity_type,
    entityId: row.entity_id,
    authorId: row.author_id,
    authorName: row.author_name ?? null,
    mimeType: row.mime_type,
    durationSeconds: Number(row.duration_seconds) || 0,
    durationLabel: formatDuration(Number(row.duration_seconds) || 0),
    sizeBytes: Number(row.size_bytes) || 0,
    sizeLabel: formatBytes(Number(row.size_bytes) || 0),
    transcript: row.transcript ?? null,
    transcriptStatus: row.transcript_status,
    transcriptLang: row.transcript_lang ?? null,
    transcriptConfidence: row.transcript_confidence ?? null,
    audioPath: `/api/voice-notes/${row.id}/audio`,
    path: pathFor(row),
    createdAt: row.created_at,
  };
}

function pathFor(row) {
  if (!row.entity_id) return null;
  return {
    document: `/documents/${row.entity_id}`,
    query: `/queries/${row.entity_id}`,
    client: `/clients/${row.entity_id}`,
    task: '/tasks',
  }[row.entity_type] ?? null;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function extensionFor(mime) {
  return {
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
  }[mime] ?? 'webm';
}

export { router as voiceNotesRouter, AUDIO_LIMITS };
