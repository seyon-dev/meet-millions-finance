/**
 * Cloud storage providers: Google Drive, Dropbox and OneDrive/SharePoint.
 *
 * All three mirror *verified* documents out of R2 into the firm's own storage,
 * preserving a folder structure per company and client. Each authenticates
 * with OAuth 2.0; the tenant's refresh token is stored encrypted and exchanged
 * for an access token on demand.
 */

import { Provider, RESULT_STATUS } from './base.js';

class OAuthStorageProvider extends Provider {
  /**
   * @param {object} connection oauth_connections row with a decrypted refresh token
   */
  withConnection(connection) {
    this.connection = connection;
    return this;
  }

  hasConnection() {
    return !!this.connection?.refresh_token;
  }

  notConnected(action = 'sync that document') {
    return {
      ok: false,
      status: RESULT_STATUS.NOT_CONFIGURED,
      error: {
        code: 'not_connected',
        message: `No ${this.name} account is connected. Connect one in Settings → Integrations before we can ${action}.`,
      },
    };
  }
}

// ===========================================================================
// GOOGLE DRIVE
// ===========================================================================

export class GoogleDriveProvider extends OAuthStorageProvider {
  constructor(env) {
    super({
      key: 'google_drive',
      name: 'Google Drive',
      category: 'storage',
      requiredKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      env,
      docsUrl: 'https://developers.google.com/drive/api/guides/about-sdk',
    });
  }

  async accessToken() {
    if (!this.isConfigured()) return this.notConfigured('reach Google Drive');
    if (!this.hasConnection()) return this.notConnected('reach Google Drive');

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
    return this.success({ token: res.body.access_token, expiresIn: res.body.expires_in });
  }

  /** Find or create a folder by name under a parent. */
  async ensureFolder(token, name, parentId = 'root') {
    const query = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
      "mimeType = 'application/vnd.google-apps.folder'",
      'trashed = false',
    ].join(' and ');

    const found = await this.request(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (found.ok && found.body?.files?.length) return { ok: true, id: found.body.files[0].id, created: false };

    const createRes = await this.request('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    if (!createRes.ok) return { ok: false, error: createRes.error };
    return { ok: true, id: createRes.body.id, created: true };
  }

  /** Upload bytes into a folder path, creating folders as needed. */
  async uploadFile({ folderPath, fileName, mimeType, bytes }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const token = tokenResult.data.token;

    let parentId = 'root';
    for (const segment of String(folderPath).split('/').filter(Boolean)) {
      const folder = await this.ensureFolder(token, segment, parentId);
      if (!folder.ok) return this.failure(folder.error, { code: 'drive_folder_failed' });
      parentId = folder.id;
    }

    // Multipart upload: metadata part, then the file part.
    const boundary = `mm${Date.now().toString(36)}`;
    const metadata = JSON.stringify({ name: fileName, parents: [parentId] });
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--`);
    const fileBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    const body = new Uint8Array(head.length + fileBytes.length + tail.length);
    body.set(head, 0);
    body.set(fileBytes, head.length);
    body.set(tail, head.length + fileBytes.length);

    const res = await this.request(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
        timeoutMs: 60000,
      });

    if (!res.ok) return this.failure(res.error, { code: 'drive_upload_failed', raw: res.body });
    return this.success({
      fileId: res.body.id, name: res.body.name, link: res.body.webViewLink, path: folderPath,
    }, { status: RESULT_STATUS.SENT, providerId: res.body.id });
  }

  async test() {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request(
      'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota',
      { headers: { Authorization: `Bearer ${tokenResult.data.token}` } });
    if (!res.ok) return this.failure(res.error, { code: 'drive_test_failed', raw: res.body });
    return this.success({ user: res.body?.user?.emailAddress, quota: res.body?.storageQuota });
  }
}

// ===========================================================================
// DROPBOX
// ===========================================================================

export class DropboxProvider extends OAuthStorageProvider {
  constructor(env) {
    super({
      key: 'dropbox',
      name: 'Dropbox',
      category: 'storage',
      requiredKeys: ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET'],
      env,
      docsUrl: 'https://www.dropbox.com/developers/documentation/http/documentation',
    });
  }

  async accessToken() {
    if (!this.isConfigured()) return this.notConfigured('reach Dropbox');
    if (!this.hasConnection()) return this.notConnected('reach Dropbox');

    const res = await this.request('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + btoa(`${this.env.DROPBOX_APP_KEY}:${this.env.DROPBOX_APP_SECRET}`),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.connection.refresh_token,
      }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'dropbox_token_failed', raw: res.body });
    return this.success({ token: res.body.access_token });
  }

  async uploadFile({ folderPath, fileName, bytes }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;

    const path = `/${String(folderPath).split('/').filter(Boolean).join('/')}/${fileName}`;
    const res = await this.request('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenResult.data.token}`,
        'Content-Type': 'application/octet-stream',
        // Dropbox keeps prior revisions automatically, which is the
        // "version history preserved" feature the addendum specifies.
        'Dropbox-API-Arg': JSON.stringify({
          path, mode: 'add', autorename: true, mute: false, strict_conflict: false,
        }),
      },
      body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      timeoutMs: 60000,
    });

    if (!res.ok) return this.failure(res.error, { code: 'dropbox_upload_failed', raw: res.body });
    return this.success({
      fileId: res.body.id, name: res.body.name, path: res.body.path_display, rev: res.body.rev,
    }, { status: RESULT_STATUS.SENT, providerId: res.body.id });
  }

  async test() {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResult.data.token}` },
    });
    if (!res.ok) return this.failure(res.error, { code: 'dropbox_test_failed', raw: res.body });
    return this.success({ account: res.body?.email, name: res.body?.name?.display_name });
  }
}

// ===========================================================================
// ONEDRIVE / SHAREPOINT
// ===========================================================================

export class OneDriveProvider extends OAuthStorageProvider {
  constructor(env) {
    super({
      key: 'onedrive',
      name: 'OneDrive / SharePoint',
      category: 'storage',
      requiredKeys: ['MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET'],
      optionalKeys: ['MS_GRAPH_TENANT_ID'],
      env,
      docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/onedrive',
    });
  }

  async accessToken() {
    if (!this.isConfigured()) return this.notConfigured('reach OneDrive');
    if (!this.hasConnection()) return this.notConnected('reach OneDrive');

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

  async uploadFile({ folderPath, fileName, mimeType, bytes }) {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;

    const cleanPath = String(folderPath).split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${cleanPath}/${encodeURIComponent(fileName)}:/content`;

    const res = await this.request(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenResult.data.token}`,
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      timeoutMs: 60000,
    });

    if (!res.ok) return this.failure(res.error, { code: 'onedrive_upload_failed', raw: res.body });
    return this.success({
      fileId: res.body.id, name: res.body.name, link: res.body.webUrl, path: folderPath,
    }, { status: RESULT_STATUS.SENT, providerId: res.body.id });
  }

  async test() {
    const tokenResult = await this.accessToken();
    if (!tokenResult.ok) return tokenResult;
    const res = await this.request('https://graph.microsoft.com/v1.0/me/drive', {
      headers: { Authorization: `Bearer ${tokenResult.data.token}` },
    });
    if (!res.ok) return this.failure(res.error, { code: 'onedrive_test_failed', raw: res.body });
    return this.success({ driveType: res.body?.driveType, owner: res.body?.owner?.user?.displayName });
  }
}

export const STORAGE_PROVIDERS = {
  google_drive: GoogleDriveProvider,
  dropbox: DropboxProvider,
  onedrive: OneDriveProvider,
};

export function storageProvider(key, env) {
  const Ctor = STORAGE_PROVIDERS[key];
  return Ctor ? new Ctor(env) : null;
}
