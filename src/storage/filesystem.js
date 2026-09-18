/**
 * Document storage on a filesystem, with R2's interface.
 *
 * The application reaches storage only through src/services/storage.js, which
 * in turn uses six methods on `env.DOCS`: put, get, head, delete, list and the
 * object's arrayBuffer/text. Providing those over a directory is the whole of
 * the move off R2 — no calling code changes.
 *
 * Security, which matters more here than it did on R2
 * ---------------------------------------------------
 * R2 buckets are private by default and unreachable except through the Worker.
 * A directory on a shared host is not: if it sits under the web root, every
 * client document is one guessed URL away. So:
 *
 *   * the storage root MUST be outside the directory the app serves. server.js
 *     refuses to start otherwise, rather than trusting configuration.
 *   * a key is resolved and then checked to be inside the root, so a key
 *     containing `../` cannot escape — the check is on the resolved path, not
 *     on the string, because string checks miss symlinks and encodings.
 *   * files are written 0600 and directories 0700: on shared hosting other
 *     accounts may share the filesystem.
 *   * nothing here serves a file over HTTP. Downloads keep going through the
 *     authorised /files route, which checks permissions and tenant first.
 *
 * Keys are tenant-prefixed by the caller already, so the directory layout
 * inherits tenant isolation from the key scheme.
 */

import { mkdir, writeFile, readFile, unlink, stat, readdir, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** Where metadata lives: alongside the object, since a filesystem has none. */
const META_SUFFIX = '.meta.json';

export class FilesystemStorage {
  /**
   * @param {string} root absolute path to the storage directory
   */
  constructor(root) {
    if (!root) {
      throw new Error(
        'STORAGE_ROOT is not set, so there is nowhere to put uploaded documents. '
        + 'See docs/hostinger-deployment.md.');
    }
    this.root = resolve(root);
  }

  /**
   * Resolve a key to a path inside the root, or refuse.
   *
   * The check is on the resolved path rather than the key text: `a/../../b`
   * and an encoded equivalent both normalise to something outside the root,
   * and only resolution catches them both.
   */
  _pathFor(key) {
    const clean = String(key ?? '').replace(/^\/+/, '');
    if (!clean) throw new Error('An empty storage key is not valid.');

    const full = resolve(this.root, clean);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Refusing a storage key that escapes the storage root: ${key}`);
    }
    return full;
  }

  async put(key, value, options = {}) {
    const path = this._pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    const body = value instanceof ArrayBuffer ? Buffer.from(value)
      : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : typeof value === 'string' ? Buffer.from(value, 'utf8')
      : Buffer.from(await new Response(value).arrayBuffer());

    // 0600: readable by this account only. On shared hosting the filesystem
    // may be visible to other accounts on the same machine.
    await writeFile(path, body, { mode: 0o600 });

    const etag = createHash('sha256').update(body).digest('hex').slice(0, 32);
    const meta = {
      key,
      size: body.byteLength,
      etag,
      uploaded: new Date().toISOString(),
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    };
    await writeFile(path + META_SUFFIX, JSON.stringify(meta), { mode: 0o600 });

    return { key, size: meta.size, etag, uploaded: new Date(meta.uploaded) };
  }

  async _meta(path, key) {
    try {
      return JSON.parse(await readFile(path + META_SUFFIX, 'utf8'));
    } catch {
      // A file written before its metadata, or restored from a backup that
      // did not carry it: report what the filesystem knows rather than fail.
      const s = await stat(path);
      return {
        key, size: s.size, etag: `size-${s.size}`,
        uploaded: s.mtime.toISOString(), httpMetadata: {}, customMetadata: {},
      };
    }
  }

  async get(key) {
    const path = this._pathFor(key);
    if (!existsSync(path)) return null;

    const meta = await this._meta(path, key);
    const buffer = await readFile(path);

    return {
      key, size: meta.size, etag: meta.etag, uploaded: new Date(meta.uploaded),
      httpMetadata: meta.httpMetadata, customMetadata: meta.customMetadata,
      // A stream, so a large document is not held in memory twice on its way
      // to the response.
      get body() { return createReadStream(path); },
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      text: async () => buffer.toString('utf8'),
      json: async () => JSON.parse(buffer.toString('utf8')),
      writeHttpMetadata: (headers) => {
        if (meta.httpMetadata?.contentType) headers.set('Content-Type', meta.httpMetadata.contentType);
        if (meta.httpMetadata?.contentDisposition) {
          headers.set('Content-Disposition', meta.httpMetadata.contentDisposition);
        }
      },
    };
  }

  async head(key) {
    const path = this._pathFor(key);
    if (!existsSync(path)) return null;
    const meta = await this._meta(path, key);
    return {
      key, size: meta.size, etag: meta.etag, uploaded: new Date(meta.uploaded),
      httpMetadata: meta.httpMetadata, customMetadata: meta.customMetadata,
    };
  }

  async delete(key) {
    const path = this._pathFor(key);
    await unlink(path).catch(() => {});
    await unlink(path + META_SUFFIX).catch(() => {});
    return true;
  }

  async list({ prefix = '', limit = 1000 } = {}) {
    const objects = [];
    const base = this._pathFor(prefix || '.');
    const start = existsSync(base) && (await stat(base)).isDirectory() ? base : dirname(base);
    if (!existsSync(start)) return { objects, truncated: false };

    const walk = async (dir) => {
      if (objects.length >= limit) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (objects.length >= limit) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (entry.name.endsWith(META_SUFFIX)) continue;

        const key = full.slice(this.root.length + 1).split(sep).join('/');
        if (prefix && !key.startsWith(prefix)) continue;
        const meta = await this._meta(full, key);
        objects.push({ key, size: meta.size, etag: meta.etag, uploaded: new Date(meta.uploaded) });
      }
    };

    await walk(start);
    return { objects, truncated: objects.length >= limit };
  }

  /** Used by the retention job, which deletes a tenant's whole prefix. */
  async deletePrefix(prefix) {
    const path = this._pathFor(prefix);
    if (!existsSync(path)) return 0;
    const { objects } = await this.list({ prefix, limit: 100000 });
    await rm(path, { recursive: true, force: true });
    return objects.length;
  }
}

/**
 * Build the binding, and prove the directory is usable before the app starts.
 *
 * A storage root that turns out to be unwritable at the moment somebody
 * uploads their first document is a much worse failure than one that stops
 * the process at boot with the path in the message.
 */
export async function createFilesystemStorage(env = process.env) {
  const root = env.STORAGE_ROOT;
  const storage = new FilesystemStorage(root);

  await mkdir(storage.root, { recursive: true, mode: 0o700 });
  const probe = `.write-probe-${Date.now()}`;
  try {
    await storage.put(probe, 'ok');
    await storage.delete(probe);
  } catch (err) {
    throw new Error(
      `The storage directory ${storage.root} is not writable: ${err.message}. `
      + 'Documents cannot be stored. See docs/hostinger-deployment.md.');
  }

  return storage;
}
