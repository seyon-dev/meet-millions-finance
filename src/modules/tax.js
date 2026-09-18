/**
 * Tax calculation: GST and TDS records, the computation runs that turn them
 * into a summary, the rate book, and the standalone calculators the
 * Tax Calculation screen uses.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../http/errors.js';
import { safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, monthKey, quarterKey, financialYearKey, recentMonthKeys } from '../utils/time.js';
import { formatINR, toPaise } from '../utils/money.js';
import { audit, auditAsync, recordActivity } from '../services/audit.js';
import { assertFeature, hasFeature } from '../services/features.js';
import {
  runComputation, previewGst, previewTds, listRules, resolveRule,
  computeGstLine, summariseGst, summariseTds, periodTotals, isInterState, tdsCodeFor,
} from '../services/tax-engine.js';
import { refreshFilingPeriod } from '../services/workflow.js';
import { getVisibleClient } from './clients.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// Computations
// ---------------------------------------------------------------------------
router.get('/computations', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('tax_computations', 'tc');
  where.eqIf('tc.client_id', ctx.q('clientId'));
  where.eqIf('tc.regime', ctx.q('regime'));
  where.eqIf('tc.period_key', ctx.q('periodKey'));
  where.eqIf('tc.period_type', ctx.q('periodType'));
  where.eqIf('tc.status', ctx.q('status'));
  where.eqIf('tc.filing_period_id', ctx.q('periodId'));
  if (!ctx.qBool('includeSuperseded')) where.add("tc.status != 'superseded'");

  const { rows, total } = await scope.paginate('tax_computations', where, {
    columns: 'tc.*, c.display_name AS client_name, c.client_code',
    joins: 'JOIN clients c ON c.id = tc.client_id',
    alias: 'tc',
    orderBy: `tc.${safeOrder(ctx.q('sort', 'period_key'), ctx.q('dir', 'desc'), ['period_key', 'created_at', 'total_tax_paise'], 'period_key')}`,
    page, pageSize,
  });

  return paginated(rows.map(toComputation), { page, pageSize, total }, ctx);
}, { permission: 'tax.view' });

router.get('/computations/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const computation = await scope.getOrFail('tax_computations', ctx.params.id, { resource: 'Computation' });

  const client = await scope.first('clients', { id: computation.client_id });
  const company = await scope.first('companies', { id: computation.company_id });
  const period = computation.filing_period_id
    ? await scope.first('filing_periods', { id: computation.filing_period_id }) : null;

  const lines = computation.regime === 'gst'
    ? await scope.raw(
        `SELECT g.*, d.title AS document_title FROM gst_records g
           LEFT JOIN documents d ON d.id = g.document_id
          WHERE g.tenant_id = ? AND g.computation_id = ?
          ORDER BY g.direction, g.invoice_date`, [ctx.tenantId, computation.id])
    : await scope.raw(
        `SELECT t.*, d.title AS document_title FROM tds_records t
           LEFT JOIN documents d ON d.id = t.document_id
          WHERE t.tenant_id = ? AND t.computation_id = ?
          ORDER BY t.payment_date`, [ctx.tenantId, computation.id]);

  const summary = computation.regime === 'gst' ? summariseGst(lines) : summariseTds(lines);
  const reports = await scope.all('reports', { computation_id: computation.id }, { order: 'created_at DESC' });

  return ok({
    computation: toComputation(computation),
    client, company, period, lines, summary, reports,
    warnings: safeJson(computation.warnings_json, []),
  }, { ctx });
}, { permission: 'tax.view' });

/** Run (or re-run) a computation for a filing period. */
router.post('/computations/run', async (ctx) => {
  await assertFeature(ctx, 'gst_reports');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    clientId: { type: 'id', required: true },
    filingPeriodId: { type: 'id', required: true },
    regime: { type: 'enum', values: ['gst', 'tds'], default: 'gst' },
  });

  const client = await getVisibleClient(ctx, scope, input.clientId);

  const result = await runComputation(ctx, scope, {
    clientId: client.id,
    filingPeriodId: input.filingPeriodId,
    regime: input.regime,
    computedBy: ctx.userId,
  });

  // A computed period moves the filing forward.
  const period = await scope.first('filing_periods', { id: input.filingPeriodId });
  if (period && ['verified', 'under_review'].includes(period.status)) {
    await scope.update('filing_periods', period.id, { status: 'calculated' });
  }

  await audit(ctx, {
    action: 'tax.computed', category: 'tax',
    entityType: 'tax_computation', entityId: result.computation.id,
    entityLabel: `${client.display_name} — ${result.computation.period_key} ${input.regime.toUpperCase()}`,
    newValue: {
      regime: input.regime,
      totalTax: result.computation.total_tax_paise,
      netPayable: result.computation.net_payable_paise,
      lines: result.computation.line_count,
      sourceDocuments: result.computation.source_document_count,
      engineVersion: result.computation.engine_version,
    },
  });

  await recordActivity(ctx, {
    clientId: client.id, companyId: client.company_id,
    verb: 'computed', entityType: 'tax_computation', entityId: result.computation.id,
    summary: `${ctx.user.full_name} computed ${input.regime.toUpperCase()} for ${result.computation.period_key}`,
    detail: { netPayable: formatINR(result.computation.net_payable_paise) },
    visibility: 'internal', icon: 'calculator',
  });

  return ok({
    computation: toComputation(result.computation),
    summary: result.summary,
    warnings: result.warnings,
    lineCount: result.lines.length,
  }, { ctx });
}, { permission: 'tax.calculate' });

router.post('/computations/:id/finalise', async (ctx) => {
  const scope = scopeFor(ctx);
  const computation = await scope.getOrFail('tax_computations', ctx.params.id, { resource: 'Computation' });
  if (computation.status === 'final') return ok({ computation: toComputation(computation), alreadyFinal: true }, { ctx });

  const warnings = safeJson(computation.warnings_json, []);
  const blocking = warnings.filter(w => w.severity === 'warning' && w.code === 'unverified_documents');
  const body = await ctx.body();
  const input = validate(body, { acknowledgeWarnings: { type: 'boolean', default: false } });

  if (blocking.length && !input.acknowledgeWarnings) {
    throw new ConflictError(
      'This computation excludes documents that are not yet verified. Verify them, or confirm you want to finalise anyway.',
      { warnings: blocking });
  }

  await scope.update('tax_computations', computation.id, { status: 'final' });

  await audit(ctx, {
    action: 'tax.finalised', category: 'tax', severity: 'notice',
    entityType: 'tax_computation', entityId: computation.id,
    oldValue: { status: computation.status }, newValue: { status: 'final' },
    metadata: { acknowledgedWarnings: input.acknowledgeWarnings },
  });

  const updated = await scope.first('tax_computations', { id: computation.id });
  return ok({ computation: toComputation(updated) }, { ctx });
}, { permission: 'tax.finalise' });

// ---------------------------------------------------------------------------
// GST records
// ---------------------------------------------------------------------------
router.get('/gst-records', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();
  const where = scope.where('gst_records', 'g');
  where.eqIf('g.computation_id', ctx.q('computationId'));
  where.eqIf('g.client_id', ctx.q('clientId'));
  where.eqIf('g.direction', ctx.q('direction'));
  where.eqIf('g.supply_type', ctx.q('supplyType'));
  where.eqIf('g.document_id', ctx.q('documentId'));
  where.searchIf(['g.invoice_no', 'g.counterparty_name', 'g.counterparty_gstin'], ctx.q('q'));

  const { rows, total } = await scope.paginate('gst_records', where, {
    columns: 'g.*, d.title AS document_title',
    joins: 'LEFT JOIN documents d ON d.id = g.document_id',
    alias: 'g',
    orderBy: 'g.invoice_date DESC, g.created_at DESC',
    page, pageSize,
  });
  return paginated(rows, { page, pageSize, total }, ctx);
}, { permission: 'tax.view' });

router.post('/gst-records', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    computationId: { type: 'id', required: true },
    documentId: { type: 'id' },
    direction: { type: 'enum', required: true, values: ['outward', 'inward'] },
    supplyType: { type: 'enum', values: ['intra', 'inter', 'export', 'exempt', 'nil', 'non_gst', 'rcm'], default: 'intra' },
    invoiceNo: { type: 'string', max: 60 },
    invoiceDate: { type: 'date' },
    counterpartyName: { type: 'string', max: 160 },
    counterpartyGstin: { type: 'gstin', label: 'Counterparty GSTIN' },
    placeOfSupply: { type: 'string', max: 2 },
    hsnSac: { type: 'string', max: 12 },
    description: { type: 'string', max: 300 },
    quantity: { type: 'number', min: 0 },
    taxableValuePaise: { type: 'paise', required: true, min: 0 },
    ratePct: { type: 'number', required: true, min: 0, max: 100 },
    cessPct: { type: 'number', min: 0, max: 100, default: 0 },
    itcEligible: { type: 'boolean', default: true },
  });

  const computation = await scope.getOrFail('tax_computations', input.computationId, { resource: 'Computation' });
  if (computation.status === 'final') {
    throw new ConflictError('This computation is final. Reopen it before adding records.');
  }

  const company = await scope.first('companies', { id: computation.company_id });
  const interState = isInterState({
    supplierStateCode: company?.state_code,
    placeOfSupply: input.placeOfSupply,
    supplyType: input.supplyType,
  });

  const tax = computeGstLine({
    taxableValuePaise: input.taxableValuePaise,
    ratePct: input.ratePct,
    cessPct: input.cessPct,
    interState,
    supplyType: input.supplyType,
  });

  const record = await scope.insert('gst_records', {
    id: ID.gstRecord(),
    computation_id: computation.id,
    client_id: computation.client_id,
    document_id: input.documentId,
    direction: input.direction,
    supply_type: input.supplyType === 'intra' || input.supplyType === 'inter'
      ? (interState ? 'inter' : 'intra') : input.supplyType,
    invoice_no: input.invoiceNo,
    invoice_date: input.invoiceDate,
    counterparty_name: input.counterpartyName,
    counterparty_gstin: input.counterpartyGstin,
    place_of_supply: input.placeOfSupply,
    hsn_sac: input.hsnSac,
    description: input.description,
    quantity: input.quantity,
    taxable_value_paise: input.taxableValuePaise,
    rate_pct: input.ratePct,
    cgst_paise: tax.cgstPaise,
    sgst_paise: tax.sgstPaise,
    igst_paise: tax.igstPaise,
    cess_paise: tax.cessPaise,
    total_paise: tax.invoiceTotalPaise,
    itc_eligible: input.itcEligible ? 1 : 0,
    source: 'manual',
  });

  // Adding a line makes the stored summary stale until it is recomputed.
  await scope.update('tax_computations', computation.id, { status: 'stale' });

  auditAsync(ctx, {
    action: 'tax.record_edited', category: 'tax',
    entityType: 'gst_record', entityId: record.id,
    entityLabel: input.invoiceNo ?? 'GST line',
    newValue: { taxableValuePaise: input.taxableValuePaise, ratePct: input.ratePct, direction: input.direction },
  });

  return created({ record, tax, interState }, { ctx });
}, { permission: 'tax.edit' });

router.patch('/gst-records/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const record = await scope.getOrFail('gst_records', ctx.params.id, { resource: 'GST record' });
  const computation = await scope.first('tax_computations', { id: record.computation_id });
  if (computation?.status === 'final') throw new ConflictError('This computation is final.');

  const body = await ctx.body();
  const input = validate(body, {
    taxableValuePaise: { type: 'paise', min: 0 },
    ratePct: { type: 'number', min: 0, max: 100 },
    cessPct: { type: 'number', min: 0, max: 100 },
    invoiceNo: { type: 'string', max: 60 },
    counterpartyName: { type: 'string', max: 160 },
    placeOfSupply: { type: 'string', max: 2 },
    itcEligible: { type: 'boolean' },
  });

  const company = await scope.first('companies', { id: computation.company_id });
  const taxable = input.taxableValuePaise ?? record.taxable_value_paise;
  const rate = input.ratePct ?? record.rate_pct;
  const pos = input.placeOfSupply ?? record.place_of_supply;
  const interState = isInterState({
    supplierStateCode: company?.state_code, placeOfSupply: pos, supplyType: record.supply_type,
  });
  const tax = computeGstLine({
    taxableValuePaise: taxable, ratePct: rate,
    cessPct: input.cessPct ?? 0, interState, supplyType: record.supply_type,
  });

  await scope.update('gst_records', record.id, {
    taxable_value_paise: taxable,
    rate_pct: rate,
    place_of_supply: pos,
    ...(input.invoiceNo !== null ? { invoice_no: input.invoiceNo } : {}),
    ...(input.counterpartyName !== null ? { counterparty_name: input.counterpartyName } : {}),
    ...(input.itcEligible !== null ? { itc_eligible: input.itcEligible ? 1 : 0 } : {}),
    cgst_paise: tax.cgstPaise,
    sgst_paise: tax.sgstPaise,
    igst_paise: tax.igstPaise,
    cess_paise: tax.cessPaise,
    total_paise: tax.invoiceTotalPaise,
  });
  await scope.update('tax_computations', record.computation_id, { status: 'stale' });

  auditAsync(ctx, {
    action: 'tax.record_edited', category: 'tax',
    entityType: 'gst_record', entityId: record.id,
    oldValue: { taxableValuePaise: record.taxable_value_paise, ratePct: record.rate_pct },
    newValue: { taxableValuePaise: taxable, ratePct: rate },
  });

  const updated = await scope.first('gst_records', { id: record.id });
  return ok({ record: updated }, { ctx });
}, { permission: 'tax.edit' });

router.delete('/gst-records/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const record = await scope.getOrFail('gst_records', ctx.params.id, { resource: 'GST record' });
  const computation = await scope.first('tax_computations', { id: record.computation_id });
  if (computation?.status === 'final') throw new ConflictError('This computation is final.');

  await scope.delete('gst_records', record.id);
  await scope.update('tax_computations', record.computation_id, { status: 'stale' });

  auditAsync(ctx, {
    action: 'tax.record_edited', category: 'tax', severity: 'notice',
    entityType: 'gst_record', entityId: record.id,
    oldValue: { invoiceNo: record.invoice_no, taxableValuePaise: record.taxable_value_paise },
  });
  return ok({ deleted: true }, { ctx });
}, { permission: 'tax.edit' });

// ---------------------------------------------------------------------------
// TDS records
// ---------------------------------------------------------------------------
router.get('/tds-records', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();
  const where = scope.where('tds_records', 't');
  where.eqIf('t.computation_id', ctx.q('computationId'));
  where.eqIf('t.client_id', ctx.q('clientId'));
  where.eqIf('t.section_code', ctx.q('section'));
  where.searchIf(['t.deductee_name', 't.deductee_pan', 't.challan_no'], ctx.q('q'));

  const { rows, total } = await scope.paginate('tds_records', where, {
    columns: 't.*, d.title AS document_title',
    joins: 'LEFT JOIN documents d ON d.id = t.document_id',
    alias: 't', orderBy: 't.payment_date DESC', page, pageSize,
  });
  return paginated(rows, { page, pageSize, total }, ctx);
}, { permission: 'tax.view' });

router.post('/tds-records', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    computationId: { type: 'id', required: true },
    documentId: { type: 'id' },
    sectionCode: { type: 'string', required: true, max: 12 },
    deducteeName: { type: 'string', required: true, max: 160 },
    deducteePan: { type: 'pan', label: 'Deductee PAN' },
    payeeType: { type: 'enum', values: ['individual', 'huf', 'company', 'firm', 'other'], default: 'company' },
    paymentDate: { type: 'date' },
    amountPaise: { type: 'paise', required: true, min: 0 },
    depositedPaise: { type: 'paise', min: 0, default: 0 },
    challanNo: { type: 'string', max: 40 },
    depositedOn: { type: 'date' },
    lowerDeductionCert: { type: 'string', max: 40 },
  });

  const computation = await scope.getOrFail('tax_computations', input.computationId, { resource: 'Computation' });
  if (computation.status === 'final') throw new ConflictError('This computation is final.');

  // Year-to-date payments to this deductee decide whether the threshold is met.
  const priorRow = await scope.rawOne(
    `SELECT COALESCE(SUM(amount_paise), 0) AS ytd FROM tds_records
      WHERE tenant_id = ? AND client_id = ? AND section_code = ?
        AND (deductee_pan = ? OR deductee_name = ?)`,
    [ctx.tenantId, computation.client_id, input.sectionCode,
     input.deducteePan ?? '', input.deducteeName]);

  const preview = await previewTds(scope, {
    amountPaise: input.amountPaise,
    sectionCode: input.sectionCode,
    payeeType: input.payeeType,
    hasPan: !!input.deducteePan,
    priorYtdPaise: Number(priorRow?.ytd) || 0,
    at: input.paymentDate ?? nowIso(),
  });

  const record = await scope.insert('tds_records', {
    id: ID.tdsRecord(),
    computation_id: computation.id,
    client_id: computation.client_id,
    document_id: input.documentId,
    section_code: input.sectionCode,
    deductee_name: input.deducteeName,
    deductee_pan: input.deducteePan,
    payee_type: input.payeeType,
    payment_date: input.paymentDate,
    amount_paise: input.amountPaise,
    rate_pct: preview.ratePct,
    tds_paise: preview.tdsPaise,
    deposited_paise: input.depositedPaise ?? 0,
    challan_no: input.challanNo,
    deposited_on: input.depositedOn,
    lower_deduction_cert: input.lowerDeductionCert,
    source: 'manual',
  });

  await scope.update('tax_computations', computation.id, { status: 'stale' });

  auditAsync(ctx, {
    action: 'tax.record_edited', category: 'tax',
    entityType: 'tds_record', entityId: record.id, entityLabel: input.deducteeName,
    newValue: { section: input.sectionCode, amountPaise: input.amountPaise, tdsPaise: preview.tdsPaise },
  });

  return created({ record, calculation: preview }, { ctx });
}, { permission: 'tax.edit' });

// ---------------------------------------------------------------------------
// Calculators — no persistence, just the arithmetic
// ---------------------------------------------------------------------------
router.post('/calculate/gst', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    taxableValuePaise: { type: 'paise', required: true, min: 0 },
    ratePct: { type: 'number', required: true, min: 0, max: 100 },
    cessPct: { type: 'number', min: 0, max: 100, default: 0 },
    supplierStateCode: { type: 'string', max: 2 },
    placeOfSupply: { type: 'string', max: 2 },
    supplyType: { type: 'enum', values: ['intra', 'inter', 'export', 'exempt', 'nil', 'non_gst', 'rcm'], default: 'intra' },
    companyId: { type: 'id' },
  });

  let supplierStateCode = input.supplierStateCode;
  if (!supplierStateCode && input.companyId) {
    const company = await scope.first('companies', { id: input.companyId });
    supplierStateCode = company?.state_code;
  }

  const result = await previewGst(scope, { ...input, supplierStateCode });
  return ok({
    ...result,
    formatted: {
      taxableValue: formatINR(input.taxableValuePaise),
      cgst: formatINR(result.cgstPaise),
      sgst: formatINR(result.sgstPaise),
      igst: formatINR(result.igstPaise),
      cess: formatINR(result.cessPaise),
      totalTax: formatINR(result.totalTaxPaise),
      invoiceTotal: formatINR(result.invoiceTotalPaise),
    },
  }, { ctx });
}, { permission: 'tax.view' });

router.post('/calculate/tds', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    amountPaise: { type: 'paise', required: true, min: 0 },
    sectionCode: { type: 'string', required: true, max: 12 },
    payeeType: { type: 'enum', values: ['individual', 'huf', 'company', 'firm', 'other'], default: 'company' },
    hasPan: { type: 'boolean', default: true },
    priorYtdPaise: { type: 'paise', min: 0, default: 0 },
  });

  const result = await previewTds(scope, input);
  return ok({
    ...result,
    formatted: {
      amount: formatINR(input.amountPaise),
      tds: formatINR(result.tdsPaise),
      netPayable: formatINR(result.netPayablePaise),
      threshold: formatINR(result.thresholdPaise),
    },
  }, { ctx });
}, { permission: 'tax.view' });

// ---------------------------------------------------------------------------
// The rate book
// ---------------------------------------------------------------------------
router.get('/rules', async (ctx) => {
  const scope = scopeFor(ctx);
  const rules = await listRules(scope, { regime: ctx.q('regime') });
  return ok(rules.map(r => ({
    ...r,
    isPlatformDefault: r.tenant_id === null,
    thresholdFormatted: formatINR(r.threshold_paise),
  })), { ctx });
}, { permission: 'tax.view' });

router.post('/rules', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    regime: { type: 'enum', required: true, values: ['gst', 'tds', 'tcs', 'cess'] },
    code: { type: 'string', required: true, max: 40 },
    name: { type: 'string', required: true, max: 160 },
    description: { type: 'text', max: 1000 },
    hsnSac: { type: 'string', max: 12 },
    sectionCode: { type: 'string', max: 12 },
    ratePct: { type: 'number', required: true, min: 0, max: 100 },
    cessPct: { type: 'number', min: 0, max: 100, default: 0 },
    thresholdPaise: { type: 'paise', min: 0, default: 0 },
    payeeType: { type: 'enum', values: ['individual', 'huf', 'company', 'firm', 'any'] },
    effectiveFrom: { type: 'date', required: true },
    effectiveTo: { type: 'date' },
    sourceNote: { type: 'string', max: 500 },
  });

  const rule = await scope.insert('tax_rules', {
    id: ID.taxRule(),
    regime: input.regime,
    code: input.code.toUpperCase(),
    name: input.name,
    description: input.description,
    hsn_sac: input.hsnSac,
    section_code: input.sectionCode,
    rate_pct: input.ratePct,
    cgst_pct: input.regime === 'gst' ? input.ratePct / 2 : 0,
    sgst_pct: input.regime === 'gst' ? input.ratePct / 2 : 0,
    igst_pct: input.regime === 'gst' ? input.ratePct : 0,
    cess_pct: input.cessPct,
    threshold_paise: input.thresholdPaise,
    payee_type: input.payeeType,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
    // A rule an administrator enters is verified by definition; only rules a
    // model proposes are written unverified.
    is_verified: 1,
    source_note: input.sourceNote,
  });

  await audit(ctx, {
    action: 'tax.rule_changed', category: 'tax', severity: 'notice',
    entityType: 'tax_rule', entityId: rule.id, entityLabel: `${input.regime.toUpperCase()} ${input.code}`,
    newValue: { code: input.code, ratePct: input.ratePct, effectiveFrom: input.effectiveFrom },
  });

  return created({ rule }, { ctx });
}, { permission: 'tax.rules.manage' });

router.patch('/rules/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  // Platform defaults carry tenant_id NULL, so they fall outside the tenant
  // scope. Look the rule up across both and refuse the platform ones
  // explicitly, rather than reporting a misleading 404.
  const rule = await scope.rawOne(
    'SELECT * FROM tax_rules WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)',
    [ctx.params.id, ctx.tenantId]);
  if (!rule) throw new NotFoundError('Tax rule');
  if (rule.tenant_id === null) {
    throw new ForbiddenError('Platform default rates cannot be edited. Add a rule of your own with a later effective date to override it.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', max: 160 },
    ratePct: { type: 'number', min: 0, max: 100 },
    thresholdPaise: { type: 'paise', min: 0 },
    effectiveTo: { type: 'date' },
    isVerified: { type: 'boolean' },
    sourceNote: { type: 'string', max: 500 },
  });

  const patch = {};
  if (input.name !== null) patch.name = input.name;
  if (input.ratePct !== null) {
    patch.rate_pct = input.ratePct;
    if (rule.regime === 'gst') {
      patch.cgst_pct = input.ratePct / 2;
      patch.sgst_pct = input.ratePct / 2;
      patch.igst_pct = input.ratePct;
    }
  }
  if (input.thresholdPaise !== null) patch.threshold_paise = input.thresholdPaise;
  if (input.effectiveTo !== null) patch.effective_to = input.effectiveTo;
  if (input.isVerified !== null) patch.is_verified = input.isVerified ? 1 : 0;
  if (input.sourceNote !== null) patch.source_note = input.sourceNote;

  await scope.update('tax_rules', rule.id, patch);

  await audit(ctx, {
    action: 'tax.rule_changed', category: 'tax', severity: 'notice',
    entityType: 'tax_rule', entityId: rule.id, entityLabel: rule.code,
    oldValue: { ratePct: rule.rate_pct, thresholdPaise: rule.threshold_paise, isVerified: rule.is_verified },
    newValue: patch,
  });

  const updated = await scope.first('tax_rules', { id: rule.id });
  return ok({ rule: updated }, { ctx });
}, { permission: 'tax.rules.manage' });

// ---------------------------------------------------------------------------
// Summaries for the dashboards
// ---------------------------------------------------------------------------
router.get('/summary', async (ctx) => {
  const scope = scopeFor(ctx);
  const periodKey = ctx.q('periodKey', monthKey());
  const clientId = ctx.q('clientId');

  const gst = await periodTotals(scope, { periodKey, regime: 'gst', clientId });
  const tds = await periodTotals(scope, { periodKey, regime: 'tds', clientId });

  // A six-month trend for the dashboard chart.
  const months = recentMonthKeys(6);
  const trend = [];
  for (const m of months) {
    const t = await periodTotals(scope, { periodKey: m, regime: 'gst', clientId });
    trend.push({
      periodKey: m,
      taxableValuePaise: t.taxableValuePaise,
      totalTaxPaise: t.totalTaxPaise,
      netPayablePaise: t.netPayablePaise,
    });
  }

  return ok({
    periodKey,
    gst: {
      ...gst,
      formatted: {
        taxableValue: formatINR(gst.taxableValuePaise),
        cgst: formatINR(gst.cgstPaise),
        sgst: formatINR(gst.sgstPaise),
        igst: formatINR(gst.igstPaise),
        cess: formatINR(gst.cessPaise),
        totalTax: formatINR(gst.totalTaxPaise),
        itc: formatINR(gst.itcTotalPaise),
        netPayable: formatINR(gst.netPayablePaise),
      },
    },
    tds: {
      ...tds,
      formatted: {
        base: formatINR(tds.tdsBasePaise),
        deducted: formatINR(tds.tdsDeductedPaise),
        deposited: formatINR(tds.tdsDepositedPaise),
      },
    },
    trend,
    periods: {
      month: monthKey(),
      quarter: quarterKey(),
      financialYear: financialYearKey(),
    },
  }, { ctx });
}, { permission: 'tax.view' });

/** Reconciliation: computed GST against what the documents actually say. */
router.get('/reconciliation', async (ctx) => {
  const scope = scopeFor(ctx);
  const periodKey = ctx.q('periodKey', monthKey());
  const clientId = ctx.q('clientId');
  if (!clientId) throw new BadRequestError('Choose a client to reconcile.');

  const client = await getVisibleClient(ctx, scope, clientId);

  const computations = await scope.raw(
    `SELECT * FROM tax_computations
      WHERE tenant_id = ? AND client_id = ? AND period_key = ? AND status != 'superseded'`,
    [ctx.tenantId, client.id, periodKey]);

  const documents = await scope.raw(
    `SELECT d.id, d.title, d.status, dt.name AS type_name, dt.category,
            (SELECT COUNT(*) FROM gst_records g WHERE g.document_id = d.id) AS gst_lines,
            (SELECT COUNT(*) FROM tds_records t WHERE t.document_id = d.id) AS tds_lines
       FROM documents d JOIN document_types dt ON dt.id = d.document_type_id
      WHERE d.tenant_id = ? AND d.client_id = ? AND d.period_key = ? AND d.deleted_at IS NULL`,
    [ctx.tenantId, client.id, periodKey]);

  // The gaps a reconciliation is meant to surface.
  const unlinked = documents.filter(d =>
    ['verified', 'approved'].includes(d.status) && d.gst_lines === 0 && d.tds_lines === 0 &&
    ['sales', 'purchase', 'gst', 'expense'].includes(d.category));
  const unverifiedWithLines = documents.filter(d =>
    !['verified', 'approved', 'archived'].includes(d.status) && (d.gst_lines > 0 || d.tds_lines > 0));

  return ok({
    periodKey,
    client: { id: client.id, displayName: client.display_name },
    computations: computations.map(toComputation),
    documents,
    findings: [
      ...unlinked.map(d => ({
        severity: 'warning', code: 'no_records',
        message: `"${d.title}" is verified but has no tax lines recorded against it.`,
        documentId: d.id,
      })),
      ...unverifiedWithLines.map(d => ({
        severity: 'critical', code: 'unverified_with_lines',
        message: `"${d.title}" has tax lines but is not verified — those lines are excluded from the computation.`,
        documentId: d.id,
      })),
    ],
    reconciled: unlinked.length === 0 && unverifiedWithLines.length === 0,
  }, { ctx });
}, { permission: 'tax.reconcile' });

function toComputation(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    clientCode: row.client_code ?? null,
    companyId: row.company_id,
    filingPeriodId: row.filing_period_id,
    regime: row.regime,
    periodType: row.period_type,
    periodKey: row.period_key,
    taxableValuePaise: row.taxable_value_paise,
    cgstPaise: row.cgst_paise,
    sgstPaise: row.sgst_paise,
    igstPaise: row.igst_paise,
    cessPaise: row.cess_paise,
    totalTaxPaise: row.total_tax_paise,
    itcTotalPaise: row.itc_total_paise,
    netPayablePaise: row.net_payable_paise,
    tdsBasePaise: row.tds_base_paise,
    tdsDeductedPaise: row.tds_deducted_paise,
    tdsDepositedPaise: row.tds_deposited_paise,
    status: row.status,
    sourceDocumentCount: row.source_document_count,
    lineCount: row.line_count,
    warnings: safeJson(row.warnings_json, []),
    computedBy: row.computed_by,
    computedAt: row.computed_at,
    engineVersion: row.engine_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as taxRouter, toComputation };
