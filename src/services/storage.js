/**
 * Document storage on R2.
 *
 * Objects are never public. Every download goes through the Worker, which
 * re-checks the caller's permission and tenant scope before streaming bytes.
 * Where a link must be shared (an email attachment, a WhatsApp document), a
 * short-lived HMAC-signed URL is issued instead of exposing the bucket.
 *
 * Key layout (from the brief):
 *   tenant/{tenantId}/company/{companyId}/client/{clientId}/documents/{documentId}/versions/{versionId}/{filename}
 */

import { sha256Hex, hmacSha256Hex, timingSafeEqual, toHex } from '../auth/crypto.js';
import { sanitizeFilename, fileExtension } from '../utils/validate.js';
import { nowIso, addSeconds, isPast } from '../utils/time.js';
import { UPLOAD_LIMITS } from '../data/document-types.js';
import {
  PayloadTooLargeError, UnsupportedMediaTypeError, NotFoundError, ForbiddenError, AppError,
} from '../http/errors.js';

export function documentKey({ tenantId, companyId, clientId, documentId, versionId, fileName }) {
  return [
    'tenant', tenantId,
    'company', companyId,
    'client', clientId,
    'documents', documentId,
    'versions', versionId,
    sanitizeFilename(fileName),
  ].join('/');
}

export function tenantAssetKey({ tenantId, kind, id, fileName }) {
  return ['tenant', tenantId, kind, id, sanitizeFilename(fileName)].join('/');
}

export function recordingKey({ tenantId, callId, fileName = 'recording.mp3' }) {
  return ['tenant', tenantId, 'calls', callId, sanitizeFilename(fileName)].join('/');
}

export function reportKey({ tenantId, reportId, format }) {
  return ['tenant', tenantId, 'reports', reportId, `report.${format}`].join('/');
}

/**
 * Validate an upload before a byte is written.
 *
 * Extension and MIME are both checked, and an extension on the deny list is
 * refused whatever MIME type is claimed — a .exe renamed to .pdf, or an
 * .svg (which can carry script), does not get stored.
 */
export function validateUpload({ fileName, mimeType, sizeBytes, limits = UPLOAD_LIMITS }) {
  const safeName = sanitizeFilename(fileName);
  const ext = fileExtension(safeName);

  if (!safeName || safeName === 'file') {
    throw new UnsupportedMediaTypeError(limits.allowedExtensions, 'That file has no usable name.');
  }
  if (limits.blockedExtensions.includes(ext)) {
    throw new UnsupportedMediaTypeError(limits.allowedExtensions,
      `.${ext} files are not accepted for security reasons.`);
  }
  if (ext && !limits.allowedExtensions.includes(ext)) {
    throw new UnsupportedMediaTypeError(limits.allowedExtensions,
      `.${ext} files are not accepted. Allowed: ${limits.allowedExtensions.join(', ')}.`);
  }
  const normalisedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (normalisedMime && !limits.allowedMime.includes(normalisedMime)) {
    throw new UnsupportedMediaTypeError(limits.allowedMime,
      `Files of type ${normalisedMime} are not accepted.`);
  }
  if (sizeBytes > limits.maxBytes) {
    throw new PayloadTooLargeError(limits.maxBytes,
      `That file is ${formatBytes(sizeBytes)}. The limit is ${formatBytes(limits.maxBytes)}.`);
  }
  if (sizeBytes <= 0) {
    throw new UnsupportedMediaTypeError(limits.allowedExtensions, 'That file is empty.');
  }

  return { fileName: safeName, extension: ext, mimeType: normalisedMime || 'application/octet-stream', sizeBytes };
}

/** Upload limits for a tenant — plan and settings can narrow the defaults. */
export function limitsFor(env, overrides = {}) {
  const envMax = Number(env.UPLOAD_MAX_BYTES);
  const allowedMime = env.UPLOAD_ALLOWED_MIME
    ? String(env.UPLOAD_ALLOWED_MIME).split(',').map(s => s.trim()).filter(Boolean)
    : UPLOAD_LIMITS.allowedMime;
  return {
    ...UPLOAD_LIMITS,
    maxBytes: Number.isFinite(envMax) && envMax > 0 ? envMax : UPLOAD_LIMITS.maxBytes,
    // The operator's list, when one is set. This used to be a union with the
    // defaults, so UPLOAD_ALLOWED_MIME could widen what a deployment accepts
    // but never narrow it — the opposite of what a lockdown variable is for.
    allowedMime: [...new Set(allowedMime)],
    ...overrides,
  };
}

/** Write an object and return its checksum and size. */
export async function putObject(env, key, body, { contentType, fileName, metadata = {} } = {}) {
  if (!env.DOCS) throw new AppError('Document storage is not configured on this deployment.', { code: 'storage_unavailable' });

  const bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
    : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : null;
  const payload = bytes ?? body;
  const checksum = bytes ? await sha256Hex(bytes) : null;

  const result = await env.DOCS.put(key, payload, {
    httpMetadata: {
      contentType: contentType || 'application/octet-stream',
      contentDisposition: fileName ? `inline; filename="${sanitizeFilename(fileName)}"` : undefined,
    },
    customMetadata: {
      uploadedAt: nowIso(),
      ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
    },
  });

  return {
    key,
    size: result?.size ?? bytes?.byteLength ?? 0,
    etag: result?.etag ?? null,
    checksum,
  };
}

export async function getObject(env, key) {
  if (!env.DOCS) throw new AppError('Document storage is not configured on this deployment.', { code: 'storage_unavailable' });
  const object = await env.DOCS.get(key);
  if (!object) throw new NotFoundError('File', 'That file is no longer in storage.');
  return object;
}

export async function headObject(env, key) {
  if (!env.DOCS) return null;
  return env.DOCS.head(key);
}

export async function deleteObject(env, key) {
  if (!env.DOCS || !key) return false;
  await env.DOCS.delete(key);
  return true;
}

export async function listObjects(env, prefix, limit = 1000) {
  if (!env.DOCS) return { objects: [] };
  return env.DOCS.list({ prefix, limit });
}

/**
 * A signed, expiring download link.
 *
 * The signature covers the key, the expiry and the tenant, so a link cannot be
 * edited to reach another tenant's object or extended past its lifetime.
 */
export async function signDownloadUrl(env, { key, tenantId, expiresInSeconds = 900, disposition = 'inline', fileName = null }) {
  const secret = env.FILE_SIGNING_SECRET || env.AUTH_SECRET;
  if (!secret) throw new AppError('File signing is not configured.', { code: 'signing_unavailable' });

  const expires = addSeconds(expiresInSeconds);
  // The filename is part of what is signed: the name a browser saves under is
  // as much the link's content as the bytes are, and a link whose name can be
  // rewritten after signing is a link that can be made to say something its
  // issuer never did.
  const payload = `${tenantId}|${key}|${expires}|${disposition}|${fileName ?? ''}`;
  const signature = (await hmacSha256Hex(secret, payload)).slice(0, 40);

  const params = new URLSearchParams({ key, t: tenantId, e: expires, d: disposition, s: signature });
  if (fileName) params.set('n', fileName);
  return `${env.APP_URL || ''}/files/signed?${params.toString()}`;
}

/** Verify a signed link. Returns the key, or throws. */
export async function verifySignedUrl(env, searchParams) {
  const secret = env.FILE_SIGNING_SECRET || env.AUTH_SECRET;
  const key = searchParams.get('key');
  const tenantId = searchParams.get('t');
  const expires = searchParams.get('e');
  const disposition = searchParams.get('d') || 'inline';
  const signature = searchParams.get('s');

  if (!key || !tenantId || !expires || !signature) {
    throw new ForbiddenError('That download link is incomplete.');
  }
  if (isPast(expires)) {
    throw new ForbiddenError('That download link has expired. Open the document in the CRM to get a fresh one.');
  }

  const fileName = searchParams.get('n');
  const expected = (await hmacSha256Hex(secret,
    `${tenantId}|${key}|${expires}|${disposition}|${fileName ?? ''}`)).slice(0, 40);
  if (!timingSafeEqual(expected, signature)) {
    throw new ForbiddenError('That download link is not valid.');
  }

  // Belt and braces: the key must sit under the tenant prefix it claims.
  if (!key.startsWith(`tenant/${tenantId}/`)) {
    throw new ForbiddenError('That download link does not match its organisation.');
  }

  return { key, tenantId, disposition, fileName };
}

/**
 * Minimal ZIP reader.
 *
 * The client portal accepts a month's documents as a single ZIP. Rather than
 * pull in a dependency, this reads the central directory and inflates stored
 * and deflated entries using DecompressionStream, which the Workers runtime
 * provides natively.
 */
export async function readZipEntries(arrayBuffer, { maxEntries = UPLOAD_LIMITS.maxZipEntries, maxTotalBytes = 500 * 1024 * 1024 } = {}) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  // Locate the End Of Central Directory record (scan back over the comment).
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  const scanFrom = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === eocdSignature) { eocd = i; break; }
  }
  if (eocd === -1) {
    throw new UnsupportedMediaTypeError(['zip'], 'That file is not a readable ZIP archive.');
  }

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount > maxEntries) {
    throw new PayloadTooLargeError(maxEntries,
      `That archive contains ${entryCount} files. The limit is ${maxEntries} per upload.`);
  }

  const entries = [];
  let pointer = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;   // central file header

    const compressionMethod = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const uncompressedSize = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);

    const nameBytes = bytes.subarray(pointer + 46, pointer + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);

    pointer += 46 + nameLength + extraLength + commentLength;

    // Directories, macOS resource forks and hidden files are skipped silently.
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop().startsWith('.')) continue;

    // Guard against a zip bomb before inflating anything.
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxTotalBytes) {
      throw new PayloadTooLargeError(maxTotalBytes,
        'That archive expands to more data than we accept in one upload.');
    }

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localOffset });
  }

  // Inflate each entry from its local header.
  const files = [];
  for (const entry of entries) {
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localOffset + 28, true);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize);

    let content;
    if (entry.compressionMethod === 0) {
      content = raw.slice();
    } else if (entry.compressionMethod === 8) {
      try {
        content = new Uint8Array(await inflateRaw(raw));
      } catch (err) {
        files.push({ name: entry.name, error: `Could not decompress: ${err.message}`, skipped: true });
        continue;
      }
    } else {
      files.push({
        name: entry.name,
        error: `Unsupported compression method ${entry.compressionMethod}.`,
        skipped: true,
      });
      continue;
    }

    files.push({
      name: entry.name.split('/').pop(),
      path: entry.name,
      size: content.byteLength,
      content,
      skipped: false,
    });
  }

  return { entryCount, files };
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer();
}

/** Guess a MIME type from a filename when the browser does not supply one. */
export function mimeFromName(fileName) {
  const ext = fileExtension(fileName);
  const map = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
    zip: 'application/zip',
    csv: 'text/csv', txt: 'text/plain',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4', ogg: 'audio/ogg',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export { toHex, UPLOAD_LIMITS };
