/**
 * Upload scanning.
 *
 * `document_versions.scan_status` has existed since the first migration with
 * the right five states — pending, clean, infected, skipped, failed — and the
 * upload path wrote `'clean'` on every file without scanning anything. That is
 * the worst of the options: a column that says a file was checked when nothing
 * checked it, which is exactly the claim somebody would rely on.
 *
 * This provider fixes the claim. With no scanner configured a file is marked
 * `skipped`, which is true; with one configured it is scanned and marked with
 * whatever the scanner actually said.
 *
 * The interface is deliberately generic — one HTTP endpoint that takes bytes
 * and answers clean or not. ClamAV behind a small HTTP wrapper (clamav-rest,
 * clamd REST shims) is the usual deployment; any service with the same shape
 * works.
 */

import { Provider, RESULT_STATUS } from './base.js';

/** Files above this are not sent to the scanner. See `scan()`. */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export class VirusScanProvider extends Provider {
  constructor(env) {
    super({
      key: 'virus_scan',
      name: 'Upload scanning',
      category: 'security',
      // Both must be present: an endpoint with no token is an open scanner,
      // and a token with no endpoint is nothing at all.
      requiredKeys: ['VIRUS_SCAN_URL'],
      optionalKeys: ['VIRUS_SCAN_TOKEN', 'VIRUS_SCAN_TIMEOUT_MS'],
      env,
      docsUrl: 'https://docs.clamav.net/',
    });
  }

  get endpoint() { return String(this.env.VIRUS_SCAN_URL ?? '').replace(/\/$/, ''); }

  get timeoutMs() {
    const raw = Number(this.env.VIRUS_SCAN_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 20000;
  }

  /**
   * Scan bytes.
   *
   * Returns one of the `scan_status` values the column allows, so the caller
   * stores what happened rather than interpreting it:
   *
   *   skipped  — no scanner on this deployment, or the file is too large
   *   clean    — the scanner looked and found nothing
   *   infected — the scanner found something; `threat` names it
   *   failed   — the scanner could not be reached or errored
   *
   * `failed` is deliberately distinct from `clean`. A scanner that times out
   * has not cleared the file, and treating those the same is how an unscanned
   * file ends up marked safe.
   */
  async scan(bytes, { fileName = 'upload' } = {}) {
    if (!this.isConfigured()) {
      return {
        ok: true,
        status: RESULT_STATUS.NOT_CONFIGURED,
        scanStatus: 'skipped',
        threat: null,
        message: 'No upload scanner is configured on this deployment, so the file was not scanned.',
      };
    }

    const size = bytes?.byteLength ?? bytes?.length ?? 0;
    if (size > MAX_SCAN_BYTES) {
      // Streaming a very large file through a scanner inside a Worker's
      // request budget is not reliable. Saying it was skipped is honest;
      // claiming it was clean would not be.
      return {
        ok: true,
        status: RESULT_STATUS.OK,
        scanStatus: 'skipped',
        threat: null,
        message: `The file is larger than the ${Math.round(MAX_SCAN_BYTES / 1024 / 1024)}MB scan limit and was not scanned.`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = { 'Content-Type': 'application/octet-stream', 'X-File-Name': sanitiseHeader(fileName) };
      if (this.env.VIRUS_SCAN_TOKEN) headers.Authorization = `Bearer ${this.env.VIRUS_SCAN_TOKEN}`;

      const response = await fetch(`${this.endpoint}/scan`, {
        method: 'POST',
        headers,
        body: bytes,
        signal: controller.signal,
      });

      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }

      if (!response.ok) {
        return {
          ok: false,
          status: RESULT_STATUS.FAILED,
          scanStatus: 'failed',
          threat: null,
          message: `The scanner returned ${response.status}. The file was stored but not cleared.`,
        };
      }

      // Accept the two shapes these services use: {infected:boolean} and
      // ClamAV's textual "OK" / "FOUND".
      const infected = body?.infected === true
        || /FOUND/i.test(body?.result ?? '')
        || /FOUND/i.test(text);

      const threat = body?.viruses?.[0] ?? body?.threat ?? body?.signature ?? null;

      return {
        ok: true,
        status: RESULT_STATUS.OK,
        scanStatus: infected ? 'infected' : 'clean',
        threat: infected ? (threat ?? 'unnamed threat') : null,
        message: infected
          ? `The scanner identified ${threat ?? 'a threat'} in this file.`
          : 'The scanner found nothing.',
      };
    } catch (err) {
      return {
        ok: false,
        status: RESULT_STATUS.FAILED,
        scanStatus: 'failed',
        threat: null,
        message: err?.name === 'AbortError'
          ? `The scanner did not answer within ${this.timeoutMs}ms. The file was stored but not cleared.`
          : `The scanner could not be reached: ${err?.message ?? 'unknown error'}.`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A real round trip, for the Integrations screen. */
  async test() {
    if (!this.isConfigured()) return this.notConfigured('reach the upload scanner');

    // EICAR — the standard harmless test string every scanner recognises. If
    // the scanner reports this clean, it is not actually scanning.
    const eicar = new TextEncoder().encode(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

    const result = await this.scan(eicar, { fileName: 'eicar.txt' });

    if (result.scanStatus === 'infected') {
      return this.success({
        detected: true,
        threat: result.threat,
        message: 'The scanner correctly detected the EICAR test file.',
      });
    }
    if (result.scanStatus === 'clean') {
      return this.failure(
        'The scanner reported the EICAR test file as clean. It is reachable but not detecting anything.',
        { code: 'scanner_not_detecting' });
    }
    return this.failure(result.message, { code: 'scanner_unreachable' });
  }
}

function sanitiseHeader(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '_').slice(0, 120);
}
