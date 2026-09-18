import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp, registerOrg, createUserWithRole, setPlan, activateAddOn, firstTenantId, testFile,
} from './helpers/app.js';

/**
 * Voice Notes to CRM (add-on 4).
 *
 * The rules these tests hold:
 *   - with no speech credentials the note still saves and still plays, and the
 *     transcript state says `not_configured` rather than pretending;
 *   - the add-on gate is real, not a hidden button;
 *   - a document masquerading as audio is refused;
 *   - one organisation cannot reach another's recordings.
 */
describe('Voice notes', () => {
  /** A short WAV of silence — real audio, so the upload path is real too. */
  function wav(seconds = 2) {
    const rate = 8000;
    const samples = rate * seconds;
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const ascii = (o, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(o + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, samples * 2, true);
    return new Uint8Array(buffer);
  }

  function audioFile(name = 'note.wav', seconds = 2) {
    return new File([wav(seconds)], name, { type: 'audio/wav' });
  }

  async function setup({ withAddOn = true } = {}) {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);

    await setPlan(app, tenantId, 'pro');
    if (withAddOn) await activateAddOn(app, tenantId, 'voice_notes_to_crm');

    const clientRes = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Kestrel Logistics Pvt Ltd',
        companyName: 'Kestrel Logistics Private Limited',
        gstin: '24AAJCB1357S1Z7',
        pan: 'AAJCB1357S',
        contactName: 'Imran Qureshi',
        contactEmail: 'imran@kestrellogistics.test',
        contactPhone: '9898011224',
        openCurrentPeriod: true,
      },
    });
    assert.equal(clientRes.status, 201, JSON.stringify(clientRes.body));

    return { app, adminToken, tenantId, client: clientRes.data.client };
  }

  /** createUserWithRole hands back credentials; this turns them into a session. */
  async function signIn(app, user) {
    const res = await app.request('/api/auth/login', {
      method: 'POST', body: { email: user.email, password: user.password },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { ...user, token: res.data.token };
  }

  function form(file, fields = {}) {
    const fd = new FormData();
    fd.append('audio', file, file.name);
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    return fd;
  }

  test('a note saves and plays, and says plainly that it was not transcribed', async () => {
    const { app, adminToken, client } = await setup();

    const res = await app.request('/api/voice-notes', {
      method: 'POST', token: adminToken,
      body: form(audioFile('site-visit.wav', 3), { clientId: client.id, durationSeconds: 3 }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const note = res.data.voiceNote;
    assert.equal(note.clientId, client.id);
    assert.equal(note.durationSeconds, 3);
    assert.equal(note.durationLabel, '0:03');
    assert.ok(note.sizeBytes > 44, 'the audio itself was stored, not just a row');

    // The honest part: no speech credentials in the test environment.
    assert.equal(note.transcriptStatus, 'not_configured');
    assert.equal(note.transcript, null);
    assert.equal(res.data.transcription.configured, false);
    assert.ok(res.data.transcription.missingKeys.length > 0,
      'the response names what is missing rather than failing silently');

    // And the recording really comes back.
    const audio = await app.request(`/api/voice-notes/${note.id}/audio`, { token: adminToken, raw: true });
    assert.equal(audio.status, 200);
    assert.match(audio.headers.get('content-type') ?? '', /^audio\//);

    const bytes = new Uint8Array(await audio.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF', 'the bytes are the WAV that went in');
  });

  test('retrying the transcript still reports the missing credentials rather than a fake result', async () => {
    const { app, adminToken, client } = await setup();

    const created = await app.request('/api/voice-notes', {
      method: 'POST', token: adminToken,
      body: form(audioFile(), { clientId: client.id, durationSeconds: 2 }),
    });
    const id = created.data.voiceNote.id;

    const retry = await app.request(`/api/voice-notes/${id}/transcribe`, { method: 'POST', token: adminToken });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.data.configured, false);
    assert.ok(retry.data.missingKeys.length > 0);
    assert.equal(retry.data.voiceNote.transcriptStatus, 'not_configured');
  });

  test('without the add-on the endpoint refuses, rather than the button merely being hidden', async () => {
    const { app, adminToken, client } = await setup({ withAddOn: false });

    const res = await app.request('/api/voice-notes', {
      method: 'POST', token: adminToken,
      body: form(audioFile(), { clientId: client.id, durationSeconds: 2 }),
    });
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'feature_locked');
    assert.equal(res.body.error.details.requiredAddOn, 'voice_notes_to_crm');
  });

  test('a PDF renamed as audio is refused', async () => {
    const { app, adminToken, client } = await setup();

    const res = await app.request('/api/voice-notes', {
      method: 'POST', token: adminToken,
      body: form(testFile('statement.pdf', 'not audio at all'), { clientId: client.id }),
    });
    assert.equal(res.status, 415, JSON.stringify(res.body));
  });

  test('a note must be attached to something, so it cannot be lost on arrival', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/voice-notes', {
      method: 'POST', token: adminToken, body: form(audioFile()),
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  test('another organisation cannot read or play the recording', async () => {
    const { app, adminToken, client } = await setup();

    const created = await app.request('/api/voice-notes', {
      method: 'POST', token: adminToken,
      body: form(audioFile(), { clientId: client.id, durationSeconds: 2 }),
    });
    const id = created.data.voiceNote.id;

    const other = await registerOrg(app, {
      organisationName: 'Solaris Apparel LLP',
      email: 'owner@solarisapparel.test',
      fullName: 'Divya Menon',
      companyName: 'Solaris Apparel LLP',
      gstin: '33AAFCS7890P1ZJ',
      pan: 'AAFCS7890P',
    });
    assert.equal(other.res.status, 201, JSON.stringify(other.res.body));
    const outsiderToken = other.res.data.token;

    for (const path of [`/api/voice-notes/${id}`, `/api/voice-notes/${id}/audio`]) {
      const res = await app.request(path, { token: outsiderToken });
      assert.equal(res.status, 404, `${path} leaked across tenants`);
    }

    const list = await app.request('/api/voice-notes', { token: outsiderToken });
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 0, 'the list is scoped to the caller’s own organisation');
  });

  test('only the person who recorded a note, or a manager, can delete it', async () => {
    const { app, adminToken, tenantId, client } = await setup();

    const executive = await signIn(app, await createUserWithRole(app, {
      tenantId,
      email: 'sneha@meridian.test',
      fullName: 'Sneha Pillai',
      roleKey: 'finance_executive',
    }));
    const other = await signIn(app, await createUserWithRole(app, {
      tenantId,
      email: 'arjun@meridian.test',
      fullName: 'Arjun Das',
      roleKey: 'finance_executive',
    }));

    const created = await app.request('/api/voice-notes', {
      method: 'POST', token: executive.token,
      body: form(audioFile(), { clientId: client.id, durationSeconds: 2 }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.data.voiceNote.id;

    const refused = await app.request(`/api/voice-notes/${id}`, { method: 'DELETE', token: other.token });
    assert.equal(refused.status, 403, 'a colleague cannot delete somebody else’s note');

    const allowed = await app.request(`/api/voice-notes/${id}`, { method: 'DELETE', token: adminToken });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

    const gone = await app.request(`/api/voice-notes/${id}`, { token: adminToken });
    assert.equal(gone.status, 404);
  });
});
