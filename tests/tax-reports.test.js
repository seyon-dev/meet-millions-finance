import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, testFile, setPlan, firstTenantId, createUserWithRole, login } from './helpers/app.js';

describe('Tax engine and reporting', () => {
  async function setup() {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'standard');

    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Radiant Traders Pvt Ltd',
        companyName: 'Radiant Traders Private Limited',
        gstin: '33AACCN5678K1Z3',
        pan: 'AACCN5678K',
        stateCode: '33',
        contactName: 'Priya Sharma',
        contactEmail: 'priya@radianttraders.test',
        createPortalLogin: true,
      },
    });

    // Upload and verify a document so the computation has something real to
    // build on — the engine deliberately ignores unverified documents.
    const form = new FormData();
    form.set('clientId', client.data.client.id);
    form.set('filingPeriodId', client.data.period.id);
    form.append('files', testFile('sales_bills_july.pdf', 'sales register'));
    const upload = await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
    const documentId = upload.data.created[0].id;
    await app.request(`/api/verification/${documentId}/decision`, {
      method: 'POST', token: adminToken, body: { decision: 'approve' },
    });

    return { app, adminToken, tenantId, client: client.data, documentId };
  }

  test('a computation starts empty and records its provenance', async () => {
    const { app, adminToken, client } = await setup();

    const run = await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.data.computation.totalTaxPaise, 0);
    assert.equal(run.data.computation.sourceDocumentCount, 1, 'one verified document was in scope');
    assert.ok(run.data.computation.engineVersion);
    assert.ok(run.data.warnings.some(w => w.code === 'no_records'));
  });

  test('GST lines compute CGST/SGST intra-state and IGST inter-state', async () => {
    const { app, adminToken, client } = await setup();

    const run = await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    const computationId = run.data.computation.id;

    // Intra-state: supplier and place of supply both Tamil Nadu (33).
    const intra = await app.request('/api/tax/gst-records', {
      method: 'POST', token: adminToken,
      body: {
        computationId, direction: 'outward', supplyType: 'intra',
        invoiceNo: 'INV-001', counterpartyName: 'Local Buyer', placeOfSupply: '33',
        taxableValuePaise: 421860000, ratePct: 18,
      },
    });
    assert.equal(intra.status, 201, JSON.stringify(intra.body));
    // The proposal's own figures: ₹42,18,600 at 18% → CGST and SGST ₹3,79,674 each.
    assert.equal(intra.data.tax.cgstPaise, 37967400);
    assert.equal(intra.data.tax.sgstPaise, 37967400);
    assert.equal(intra.data.tax.igstPaise, 0);
    assert.equal(intra.data.interState, false);

    // Inter-state: place of supply Maharashtra (27) → IGST only.
    const inter = await app.request('/api/tax/gst-records', {
      method: 'POST', token: adminToken,
      body: {
        computationId, direction: 'outward', supplyType: 'inter',
        invoiceNo: 'INV-002', counterpartyName: 'Mumbai Buyer', placeOfSupply: '27',
        taxableValuePaise: 62455600, ratePct: 18,
      },
    });
    assert.equal(inter.data.tax.igstPaise, 11242008);
    assert.equal(inter.data.tax.cgstPaise, 0);
    assert.equal(inter.data.interState, true);

    // Input credit on an inward line.
    await app.request('/api/tax/gst-records', {
      method: 'POST', token: adminToken,
      body: {
        computationId, direction: 'inward', supplyType: 'intra',
        invoiceNo: 'PUR-001', counterpartyName: 'Supplier Co', placeOfSupply: '33',
        taxableValuePaise: 100000000, ratePct: 18, itcEligible: true,
      },
    });

    const rerun = await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });

    const c = rerun.data.computation;
    assert.equal(c.taxableValuePaise, 421860000 + 62455600);
    assert.equal(c.cgstPaise, 37967400);
    assert.equal(c.sgstPaise, 37967400);
    assert.equal(c.igstPaise, 11242008);
    assert.equal(c.totalTaxPaise, 37967400 + 37967400 + 11242008);
    assert.equal(c.itcTotalPaise, 18000000, 'input credit is 18% of ₹10,00,000');
    assert.equal(c.netPayablePaise, c.totalTaxPaise - c.itcTotalPaise);
  });

  test('the GST calculator matches the proposal figures exactly', async () => {
    const { app, adminToken } = await setup();
    const res = await app.request('/api/tax/calculate/gst', {
      method: 'POST', token: adminToken,
      body: { taxableValuePaise: 421860000, ratePct: 18, supplierStateCode: '33', placeOfSupply: '33' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.formatted.taxableValue, '₹42,18,600.00');
    assert.equal(res.data.formatted.cgst, '₹3,79,674.00');
    assert.equal(res.data.formatted.sgst, '₹3,79,674.00');
    assert.equal(res.data.ruleFound, true, 'the rate resolved from a seeded verified rule');
  });

  test('TDS applies its threshold and the section 206AA higher rate', async () => {
    const { app, adminToken } = await setup();

    const below = await app.request('/api/tax/calculate/tds', {
      method: 'POST', token: adminToken,
      body: { amountPaise: 2000000, sectionCode: '194C', payeeType: 'company' },
    });
    assert.equal(below.data.applicable, false, '₹20,000 is under the 194C threshold');
    assert.equal(below.data.tdsPaise, 0);

    const above = await app.request('/api/tax/calculate/tds', {
      method: 'POST', token: adminToken,
      body: { amountPaise: 25000000, sectionCode: '194C', payeeType: 'company' },
    });
    assert.equal(above.data.applicable, true);
    assert.equal(above.data.ratePct, 2);
    assert.equal(above.data.tdsPaise, 500000, '2% of ₹2,50,000');

    const individual = await app.request('/api/tax/calculate/tds', {
      method: 'POST', token: adminToken,
      body: { amountPaise: 25000000, sectionCode: '194C', payeeType: 'individual' },
    });
    assert.equal(individual.data.ratePct, 1, 'the individual rate for 194C is 1%');

    const noPan = await app.request('/api/tax/calculate/tds', {
      method: 'POST', token: adminToken,
      body: { amountPaise: 25000000, sectionCode: '194J', hasPan: false },
    });
    assert.equal(noPan.data.ratePct, 20, 'section 206AA raises the rate to 20% with no PAN');
    assert.match(noPan.data.reason, /206AA/);
  });

  test('an unknown TDS section is refused rather than guessed', async () => {
    const { app, adminToken } = await setup();
    const res = await app.request('/api/tax/calculate/tds', {
      method: 'POST', token: adminToken,
      body: { amountPaise: 100000, sectionCode: '999Z' },
    });
    assert.equal(res.status, 404);
    assert.match(res.error.message, /No verified TDS rule/);
  });

  test('a report is generated, submitted, approved, signed off and archived', async () => {
    const { app, adminToken, tenantId, client } = await setup();

    const run = await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    await app.request('/api/tax/gst-records', {
      method: 'POST', token: adminToken,
      body: {
        computationId: run.data.computation.id, direction: 'outward', supplyType: 'intra',
        invoiceNo: 'INV-001', placeOfSupply: '33', taxableValuePaise: 421860000, ratePct: 18,
      },
    });
    await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });

    // Generate
    const generated = await app.request('/api/reports', {
      method: 'POST', token: adminToken,
      body: {
        type: 'gst_summary', clientId: client.client.id,
        filingPeriodId: client.period.id, periodKey: run.data.computation.periodKey,
      },
    });
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    assert.match(generated.data.report.referenceNo, /^RPT-\d{4}-\d{6}$/);
    assert.equal(generated.data.report.status, 'draft');
    assert.equal(generated.data.totals.cgstPaise, 37967400);
    assert.ok(generated.data.sections.find(s => s.key === 'outward'));

    const reportId = generated.data.report.id;

    // Submit for approval
    const submitted = await app.request(`/api/reports/${reportId}/submit`, {
      method: 'POST', token: adminToken, body: { note: 'Ready for review.' },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.data.report.status, 'pending_approval');

    // It appears in the approval queue
    const queue = await app.request('/api/approvals?status=pending', { token: adminToken });
    assert.equal(queue.data.length, 1);
    assert.equal(queue.data[0].entityId, reportId);
    assert.equal(queue.meta.summary.pending, 1);

    const stats = await app.request('/api/approvals/stats', { token: adminToken });
    assert.equal(stats.data.awaitingApproval, 1);
    assert.equal(stats.data.reportsAwaiting, 1);

    // Manager approves and sends to the client
    const approved = await app.request(`/api/reports/${reportId}/decision`, {
      method: 'POST', token: adminToken,
      body: { decision: 'approve', comment: 'Figures check out.', sendToClient: true },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.data.report.status, 'client_review');

    // Approval makes the computation final
    const computation = await app.DB.prepare('SELECT status FROM tax_computations WHERE id = ?')
      .bind(run.data.computation.id).first();
    assert.equal(computation.status, 'final');

    // The client signs in and signs off
    const clientLogin = await login(app, 'priya@radianttraders.test', client.temporaryPassword);
    const clientToken = clientLogin.data.token;

    const clientView = await app.request(`/api/reports/${reportId}`, { token: clientToken });
    assert.equal(clientView.status, 200, 'the client can see an approved report');
    assert.equal(clientView.data.permissions.canSignOff, true);

    const signedOff = await app.request(`/api/reports/${reportId}/sign-off`, {
      method: 'POST', token: clientToken, body: { accepted: true, comment: 'Looks right.' },
    });
    assert.equal(signedOff.status, 200, JSON.stringify(signedOff.body));
    assert.equal(signedOff.data.report.status, 'signed_off');

    // Archive the filing package
    const archived = await app.request(`/api/reports/${reportId}/archive`, {
      method: 'POST', token: adminToken,
    });
    assert.equal(archived.data.report.status, 'archived');

    const period = await app.DB.prepare('SELECT status, archived_at FROM filing_periods WHERE id = ?')
      .bind(client.period.id).first();
    assert.equal(period.status, 'archived');
    assert.ok(period.archived_at);

    const doc = await app.DB.prepare('SELECT status, is_locked FROM documents LIMIT 1').first();
    assert.equal(doc.status, 'archived');
    assert.equal(doc.is_locked, 1, 'archived documents are locked');
  });

  test('a client cannot see a report that is still in draft', async () => {
    const { app, adminToken, client } = await setup();

    const run = await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    const generated = await app.request('/api/reports', {
      method: 'POST', token: adminToken,
      body: { type: 'gst_summary', clientId: client.client.id, filingPeriodId: client.period.id,
              periodKey: run.data.computation.periodKey },
    });

    const clientLogin = await login(app, 'priya@radianttraders.test', client.temporaryPassword);
    const attempt = await app.request(`/api/reports/${generated.data.report.id}`, {
      token: clientLogin.data.token,
    });
    assert.equal(attempt.status, 404, 'a draft report is invisible to the client');

    const list = await app.request('/api/reports', { token: clientLogin.data.token });
    assert.equal(list.data.length, 0);
  });

  test('a report exports as real CSV and a valid PDF', async () => {
    const { app, adminToken, client } = await setup();

    const run = await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    await app.request('/api/tax/gst-records', {
      method: 'POST', token: adminToken,
      body: { computationId: run.data.computation.id, direction: 'outward', supplyType: 'intra',
              invoiceNo: 'INV-001', counterpartyName: 'Local Buyer', placeOfSupply: '33',
              taxableValuePaise: 421860000, ratePct: 18 },
    });
    await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    const generated = await app.request('/api/reports', {
      method: 'POST', token: adminToken,
      body: { type: 'gst_summary', clientId: client.client.id, filingPeriodId: client.period.id,
              periodKey: run.data.computation.periodKey },
    });
    const reportId = generated.data.report.id;

    const csv = await app.request(`/api/reports/${reportId}/export?format=csv`, {
      token: adminToken, raw: true,
    });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const csvText = await csv.text();
    assert.match(csvText, /INV-001/);
    assert.match(csvText, /3,79,674/);

    const pdf = await app.request(`/api/reports/${reportId}/export?format=pdf`, {
      token: adminToken, raw: true,
    });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const head = new TextDecoder().decode(bytes.slice(0, 8));
    assert.match(head, /^%PDF-1\./, 'the response is a real PDF');
    const tail = new TextDecoder().decode(bytes.slice(-10));
    assert.match(tail, /%%EOF/);
    assert.ok(bytes.length > 2000, 'the PDF has real content');
  });

  test('CSV export neutralises formula injection in a client-supplied field', async () => {
    const { app, adminToken, client } = await setup();

    const run = await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    await app.request('/api/tax/gst-records', {
      method: 'POST', token: adminToken,
      body: {
        computationId: run.data.computation.id, direction: 'outward', supplyType: 'intra',
        invoiceNo: 'INV-003', counterpartyName: '=HYPERLINK("http://evil.test","click")',
        placeOfSupply: '33', taxableValuePaise: 100000, ratePct: 18,
      },
    });
    await app.request('/api/tax/computations/run', {
      method: 'POST', token: adminToken,
      body: { clientId: client.client.id, filingPeriodId: client.period.id, regime: 'gst' },
    });
    const generated = await app.request('/api/reports', {
      method: 'POST', token: adminToken,
      body: { type: 'gst_summary', clientId: client.client.id, filingPeriodId: client.period.id,
              periodKey: run.data.computation.periodKey },
    });

    const csv = await app.request(`/api/reports/${generated.data.report.id}/export?format=csv`, {
      token: adminToken, raw: true,
    });
    const text = await csv.text();
    assert.ok(!/(^|,)=HYPERLINK/m.test(text), 'the leading = is neutralised');
    assert.match(text, /'=HYPERLINK/, 'the value is preserved, prefixed with an apostrophe');
  });

  test('platform tax rates cannot be edited, only overridden', async () => {
    const { app, adminToken } = await setup();

    const rules = await app.request('/api/tax/rules?regime=gst', { token: adminToken });
    assert.ok(rules.data.length >= 7);
    const platformRule = rules.data.find(r => r.isPlatformDefault);
    assert.ok(platformRule);

    const attempt = await app.request(`/api/tax/rules/${platformRule.id}`, {
      method: 'PATCH', token: adminToken, body: { ratePct: 99 },
    });
    assert.equal(attempt.status, 403);
    assert.match(attempt.error.message, /cannot be edited/i);

    // A tenant rule with a later effective date wins instead.
    const own = await app.request('/api/tax/rules', {
      method: 'POST', token: adminToken,
      body: {
        regime: 'gst', code: 'GST_18', name: 'GST 18% (revised)',
        ratePct: 18, effectiveFrom: '2026-01-01T00:00:00.000Z',
        sourceNote: 'Notification 01/2026',
      },
    });
    assert.equal(own.status, 201);
    assert.equal(own.data.rule.cgst_pct, 9);
    assert.equal(own.data.rule.is_verified, 1);
  });

  test('reconciliation reports verified documents with no tax lines', async () => {
    const { app, adminToken, client } = await setup();

    const res = await app.request(
      `/api/tax/reconciliation?clientId=${client.client.id}&periodKey=${client.period.period_key}`,
      { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.data.reconciled, false);
    assert.ok(res.data.findings.some(f => f.code === 'no_records'),
      'the verified sales document with no lines is flagged');
  });
});
