import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, login, testFile, createUserWithRole, setPlan, firstTenantId } from './helpers/app.js';

/**
 * The document lifecycle from the proposal's Complete CRM Workflow page:
 * upload → verification → query → correction → verified.
 */
describe('Document and verification workflow', () => {
  async function setup() {
    const app = await createApp();
    const { res, payload } = await registerOrg(app);
    const adminToken = res.data.token;

    // Onboarding clients means creating companies, which the Basic plan caps
    // at one. A firm managing clients is on Standard or above.
    await setPlan(app, await firstTenantId(app), 'standard');

    const clientRes = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Radiant Traders Pvt Ltd',
        companyName: 'Radiant Traders Private Limited',
        gstin: '33AACCN5678K1Z3',
        pan: 'AACCN5678K',
        contactName: 'Priya Sharma',
        contactEmail: 'priya@radianttraders.test',
        contactPhone: '9845012233',
        createPortalLogin: true,
        openCurrentPeriod: true,
      },
    });
    assert.equal(clientRes.status, 201, JSON.stringify(clientRes.body));

    return { app, adminToken, payload, client: clientRes.data };
  }

  test('a client is onboarded with a company, contact, portal login and open filing period', async () => {
    const { client } = await setup();

    assert.ok(client.client.clientCode.startsWith('CL-'));
    assert.equal(client.company.gstin, '33AACCN5678K1Z3');
    assert.ok(client.portalUser, 'a portal login was created');
    assert.ok(client.temporaryPassword, 'a one-time password is returned exactly once');
    assert.ok(client.period, 'the current filing period is open');
    assert.equal(client.period.status, 'collecting');
    assert.ok(client.period.due_date, 'a statutory due date was derived');
  });

  test('uploading a document creates a version, checklist entry and audit record', async () => {
    const { app, adminToken, client } = await setup();

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('sales_bills_july.pdf', 'sales bill content here'));

    const res = await app.request('/api/documents/upload', {
      method: 'POST', token: adminToken, body: form,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.data.summary.uploaded, 1);

    const doc = res.data.created[0];
    assert.equal(doc.status, 'submitted');
    assert.equal(doc.versionCount, 1);
    assert.equal(doc.typeKey, 'sales_bills', 'the type was inferred from the filename');
    assert.ok(doc.slaDueAt, 'an SLA deadline was set');

    // The bytes really landed in storage.
    const stored = [...app.DOCS.objects.keys()];
    assert.equal(stored.length, 1);
    assert.match(stored[0], /^tenant\/.+\/documents\/.+\/versions\/.+\/sales_bills_july\.pdf$/);

    // And the audit trail recorded it.
    const auditRow = await app.DB.prepare(
      "SELECT * FROM audit_logs WHERE action = 'documents.uploaded'").first();
    assert.ok(auditRow);
    assert.equal(auditRow.entity_id, doc.id);
    assert.ok(auditRow.hash, 'the entry is hash-chained');
  });

  test('a ZIP upload is expanded into individual documents', async () => {
    const { app, adminToken, client } = await setup();

    const zip = buildZip([
      ['bank_statement_july.pdf', 'bank statement content'],
      ['purchase_bills_july.pdf', 'purchase bills content'],
      ['notes.exe', 'malicious'],           // must be refused
      ['__MACOSX/._junk', 'resource fork'], // must be ignored
    ]);

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', new File([zip], 'july-2026.zip', { type: 'application/zip' }));

    const res = await app.request('/api/documents/upload', {
      method: 'POST', token: adminToken, body: form,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    assert.equal(res.data.created.length, 2, 'both valid files were ingested');
    assert.equal(res.data.skipped.length, 1, 'the .exe was refused');
    assert.match(res.data.skipped[0].fileName, /notes\.exe/);
    assert.ok(res.data.batch, 'a batch record was written');
    assert.equal(res.data.batch.status, 'partial');

    const titles = res.data.created.map(d => d.typeKey).sort();
    assert.deepEqual(titles, ['bank_statements', 'purchase_bills']);
  });

  test('an executable is refused even when uploaded directly', async () => {
    const { app, adminToken, client } = await setup();
    const form = new FormData();
    form.set('clientId', client.client.id);
    form.append('files', testFile('payload.exe', 'MZ', 'application/pdf'));

    const res = await app.request('/api/documents/upload', {
      method: 'POST', token: adminToken, body: form,
    });
    assert.equal(res.data.failed.length, 1);
    assert.match(res.data.failed[0].reason, /not accepted/i);
    assert.equal(app.DOCS.objects.size, 0, 'nothing was written to storage');
  });

  test('the full query loop: raise, client replies with a corrected file, executive verifies', async () => {
    const { app, adminToken, client } = await setup();

    // 1. Client uploads.
    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('bank_statement_july.pdf', 'original statement'));
    const upload = await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
    const documentId = upload.data.created[0].id;

    // 2. Executive opens it — it moves to under review.
    const opened = await app.request(`/api/verification/${documentId}/open`, { method: 'POST', token: adminToken });
    assert.equal(opened.data.document.status, 'under_review');

    // 3. Executive raises a query.
    const decision = await app.request(`/api/verification/${documentId}/decision`, {
      method: 'POST', token: adminToken,
      body: {
        decision: 'raise_query',
        querySubject: 'Closing balance does not match',
        queryBody: 'The closing balance on page 3 does not match the opening balance of the next month. Please re-download the statement from your bank.',
        queryPriority: 'high',
      },
    });
    assert.equal(decision.status, 200, JSON.stringify(decision.body));
    assert.equal(decision.data.document.status, 'query_raised');
    assert.ok(decision.data.query, 'a query thread was opened');
    assert.match(decision.data.query.reference_no, /^QRY-\d{4}-\d{6}$/);

    const queryId = decision.data.query.id;

    // 4. The client signs in and sees the query.
    const clientLogin = await login(app, 'priya@radianttraders.test', client.temporaryPassword);
    assert.equal(clientLogin.status, 200, JSON.stringify(clientLogin.body));
    const clientToken = clientLogin.data.token;

    const clientQueries = await app.request('/api/queries?openOnly=true', { token: clientToken });
    assert.equal(clientQueries.status, 200);
    assert.equal(clientQueries.data.length, 1);
    assert.equal(clientQueries.data[0].id, queryId);

    // 5. Client replies and uploads the corrected file against the query.
    const reply = await app.request(`/api/queries/${queryId}/replies`, {
      method: 'POST', token: clientToken,
      body: { body: 'Apologies — here is the corrected statement from HDFC.' },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.data.query.status, 'client_responded');

    const replaceForm = new FormData();
    replaceForm.set('file', testFile('bank_statement_july_corrected.pdf', 'corrected statement'));
    replaceForm.set('note', 'Corrected closing balance.');
    replaceForm.set('queryId', queryId);
    const replaced = await app.request(`/api/documents/${documentId}/versions`, {
      method: 'POST', token: clientToken, body: replaceForm,
    });
    assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
    assert.equal(replaced.data.version.version_no, 2);
    assert.equal(replaced.data.document.status, 'submitted', 'a correction re-enters review');
    assert.equal(app.DOCS.objects.size, 2, 'the original version is still stored');

    // 6. Executive resolves the query and verifies the document.
    const resolved = await app.request(`/api/queries/${queryId}/resolve`, {
      method: 'POST', token: adminToken, body: { resolutionNote: 'Corrected statement received.' },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.query.status, 'resolved');

    await app.request(`/api/verification/${documentId}/open`, { method: 'POST', token: adminToken });
    const verified = await app.request(`/api/verification/${documentId}/decision`, {
      method: 'POST', token: adminToken,
      body: { decision: 'approve', notes: 'Balances now reconcile.' },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.data.document.status, 'verified');
    assert.ok(verified.data.document.isLocked, 'a verified document is locked by default');

    // 7. The locked document cannot be replaced.
    const blocked = await app.request(`/api/documents/${documentId}/versions`, {
      method: 'POST', token: clientToken,
      body: (() => { const f = new FormData(); f.set('file', testFile('again.pdf', 'x')); return f; })(),
    });
    assert.equal(blocked.status, 403);
    assert.match(blocked.error.message, /locked/i);

    // 8. Every step is in the immutable verification history.
    const detail = await app.request(`/api/documents/${documentId}`, { token: adminToken });
    const decisions = detail.data.verifications.map(v => v.decision);
    assert.ok(decisions.includes('query_raised'));
    assert.ok(decisions.includes('approved'));
    assert.equal(detail.data.versions.length, 2);
  });

  test('an invalid status transition is refused', async () => {
    const { app, adminToken, client } = await setup();
    const form = new FormData();
    form.set('clientId', client.client.id);
    form.append('files', testFile('expense_bills.pdf', 'x'));
    const upload = await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
    const documentId = upload.data.created[0].id;

    // Approve it, lock it, then try to approve again from the archived state.
    await app.request(`/api/verification/${documentId}/decision`, {
      method: 'POST', token: adminToken, body: { decision: 'approve' },
    });
    await app.request(`/api/documents/${documentId}/archive`, { method: 'POST', token: adminToken });

    const again = await app.request(`/api/verification/${documentId}/decision`, {
      method: 'POST', token: adminToken, body: { decision: 'approve' },
    });
    assert.equal(again.status, 403, 'a locked, archived document refuses new decisions');
  });

  test('rejecting without a reason is refused', async () => {
    const { app, adminToken, client } = await setup();
    const form = new FormData();
    form.set('clientId', client.client.id);
    form.append('files', testFile('payroll_files.pdf', 'x'));
    const upload = await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });

    const res = await app.request(`/api/verification/${upload.data.created[0].id}/decision`, {
      method: 'POST', token: adminToken, body: { decision: 'reject' },
    });
    assert.equal(res.status, 400);
    assert.match(res.error.message, /why the document was rejected/i);
  });

  test('the filing period status and counters are derived from its documents', async () => {
    const { app, adminToken, client } = await setup();

    const before = await app.request(`/api/clients/${client.client.id}/periods/${client.period.id}`, { token: adminToken });
    assert.equal(before.data.period.status, 'collecting');
    assert.ok(before.data.checklist.length >= 8, 'a monthly checklist was laid out');
    assert.equal(before.data.stages.length, 10, 'the ten workflow stages are rendered');

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('sales_bills_july.pdf', 'x'));
    const upload = await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });

    const afterUpload = await app.request(`/api/clients/${client.client.id}/periods/${client.period.id}`, { token: adminToken });
    assert.equal(afterUpload.data.period.documents_received, 1);
    assert.equal(afterUpload.data.period.status, 'under_review');

    // The checklist entry for Sales Bills is now satisfied.
    const salesItem = afterUpload.data.checklist.find(c => c.type_key === 'sales_bills');
    assert.equal(salesItem.status, 'submitted');
    assert.equal(salesItem.document_id, upload.data.created[0].id);

    await app.request(`/api/verification/${upload.data.created[0].id}/decision`, {
      method: 'POST', token: adminToken, body: { decision: 'approve' },
    });

    const afterVerify = await app.request(`/api/clients/${client.client.id}/periods/${client.period.id}`, { token: adminToken });
    assert.equal(afterVerify.data.period.documents_verified, 1);
    assert.equal(afterVerify.data.checklist.find(c => c.type_key === 'sales_bills').status, 'verified');
  });

  test('the verification queue groups by status with live counts', async () => {
    const { app, adminToken, client } = await setup();

    for (const name of ['sales_bills_a.pdf', 'purchase_bills_b.pdf', 'bank_statement_c.pdf']) {
      const form = new FormData();
      form.set('clientId', client.client.id);
      form.append('files', testFile(name, 'x'));
      await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
    }

    const queue = await app.request('/api/verification/queue?tab=pending', { token: adminToken });
    assert.equal(queue.status, 200);
    assert.equal(queue.data.length, 3);
    assert.equal(queue.meta.tabs.find(t => t.key === 'pending').count, 3);

    const stats = await app.request('/api/verification/stats', { token: adminToken });
    assert.equal(stats.data.pendingReview, 3);
    assert.equal(stats.data.clientsAssigned, 1);
  });

  test('bulk approval moves several documents at once and reports skips', async () => {
    const { app, adminToken, client } = await setup();

    const ids = [];
    for (const name of ['sales_bills_a.pdf', 'purchase_bills_b.pdf']) {
      const form = new FormData();
      form.set('clientId', client.client.id);
      form.append('files', testFile(name, 'x'));
      const res = await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
      ids.push(res.data.created[0].id);
    }

    const res = await app.request('/api/verification/bulk', {
      method: 'POST', token: adminToken,
      body: { documentIds: [...ids, 'doc_does_not_exist'], decision: 'approve', notes: 'Batch verified.' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.summary.updated, 2);
    assert.equal(res.data.summary.skipped, 1);
  });
});

/**
 * Build a minimal valid ZIP archive (stored, no compression) so the ZIP
 * ingestion path is exercised against real bytes rather than a stub.
 */
function buildZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);      // stored
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);     // stored
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
