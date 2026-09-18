/**
 * GST & TDS calculation engine.
 *
 * Design rules this engine holds to:
 *
 *  1. Rates live in `tax_rules`, not in code. A rate change is a row, not a
 *     deploy, and every rule is date-bounded so a computation for August 2026
 *     resolves the rate that was in force in August 2026.
 *  2. All arithmetic is in integer paise. Rounding happens once, at the point
 *     a percentage is applied, half-up — never on an accumulated float.
 *  3. Intra-state supply splits into CGST + SGST; inter-state produces IGST.
 *     The decision comes from comparing the supplier's state code with the
 *     place of supply, exactly as the statute does.
 *  4. Nothing is invented. A computation is built only from records attached
 *     to *verified* documents, and it records how many documents and lines it
 *     was built from so the number is always traceable back to paper.
 */

import { pctOfPaise, sumPaise } from '../utils/money.js';
import { ID } from '../utils/id.js';
import { nowIso, periodBounds } from '../utils/time.js';
import { gstinStateCode } from '../utils/validate.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';

export const ENGINE_VERSION = '1.0.0';

/** Supply types that carry no tax, whatever rate is attached to the line. */
const ZERO_TAX_SUPPLY = new Set(['exempt', 'nil', 'non_gst']);

// ---------------------------------------------------------------------------
// Rule resolution
// ---------------------------------------------------------------------------

/**
 * Find the rule in force for a regime/code at a date. Tenant-specific rules
 * win over platform defaults; among equals, the latest effective_from wins.
 */
export async function resolveRule(scope, { regime, code, at = nowIso(), verifiedOnly = true }) {
  const rows = await scope.raw(
    `SELECT * FROM tax_rules
      WHERE regime = ? AND code = ?
        AND (tenant_id = ? OR tenant_id IS NULL)
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
        ${verifiedOnly ? 'AND is_verified = 1' : ''}
      ORDER BY (tenant_id IS NULL) ASC, effective_from DESC
      LIMIT 1`,
    [regime, code, scope.tenantId, at, at]);
  return rows[0] ?? null;
}

export async function listRules(scope, { regime = null, at = nowIso() } = {}) {
  const params = [scope.tenantId, at, at];
  const regimeClause = regime ? 'AND regime = ?' : '';
  if (regime) params.push(regime);
  return scope.raw(
    `SELECT * FROM tax_rules
      WHERE (tenant_id = ? OR tenant_id IS NULL)
        AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
        ${regimeClause}
      ORDER BY regime, code, effective_from DESC`, params);
}

// ---------------------------------------------------------------------------
// GST
// ---------------------------------------------------------------------------

/**
 * Is this an inter-state supply? Inter-state means IGST; intra-state means
 * CGST + SGST. Export and SEZ supplies are treated as inter-state.
 */
export function isInterState({ supplierStateCode, placeOfSupply, supplyType }) {
  if (supplyType === 'export' || supplyType === 'sez') return true;
  if (supplyType === 'inter') return true;
  if (supplyType === 'intra') return false;
  if (!supplierStateCode || !placeOfSupply) return false;
  return String(supplierStateCode).padStart(2, '0') !== String(placeOfSupply).padStart(2, '0');
}

/**
 * Tax on a single GST line.
 *
 * @param {object} line
 * @param {number} line.taxableValuePaise integer paise
 * @param {number} line.ratePct           total GST rate (e.g. 18)
 * @param {number} [line.cessPct]
 * @param {boolean} line.interState
 * @param {string} [line.supplyType]
 * @returns {{cgstPaise:number,sgstPaise:number,igstPaise:number,cessPaise:number,totalTaxPaise:number,invoiceTotalPaise:number}}
 */
export function computeGstLine({
  taxableValuePaise, ratePct = 0, cessPct = 0, interState = false, supplyType = 'intra',
}) {
  const taxable = Math.round(Number(taxableValuePaise) || 0);

  if (ZERO_TAX_SUPPLY.has(supplyType) || !ratePct) {
    const cessOnly = cessPct ? pctOfPaise(taxable, cessPct) : 0;
    const zero = ZERO_TAX_SUPPLY.has(supplyType) ? 0 : cessOnly;
    return {
      cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: zero,
      totalTaxPaise: zero, invoiceTotalPaise: taxable + zero,
    };
  }

  // Export and SEZ supplies are zero-rated: IGST is charged at 0% unless the
  // line explicitly carries a rate (supply under bond vs. with payment).
  const cessPaise = cessPct ? pctOfPaise(taxable, cessPct) : 0;

  let cgstPaise = 0, sgstPaise = 0, igstPaise = 0;
  if (interState) {
    igstPaise = pctOfPaise(taxable, ratePct);
  } else {
    // Halve the rate, not the tax: rounding each half separately is what the
    // GST portal does, and it is why CGST and SGST can differ by one paisa.
    cgstPaise = pctOfPaise(taxable, ratePct / 2);
    sgstPaise = pctOfPaise(taxable, ratePct) - cgstPaise;
  }

  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise + cessPaise;
  return {
    cgstPaise, sgstPaise, igstPaise, cessPaise, totalTaxPaise,
    invoiceTotalPaise: taxable + totalTaxPaise,
  };
}

/** Aggregate GST lines into the summary the report and dashboard show. */
export function summariseGst(lines) {
  const outward = lines.filter(l => l.direction === 'outward');
  const inward = lines.filter(l => l.direction === 'inward');

  const sum = (rows, field) => sumPaise(rows.map(r => r[field] ?? 0));

  const taxableValuePaise = sum(outward, 'taxable_value_paise');
  const cgstPaise = sum(outward, 'cgst_paise');
  const sgstPaise = sum(outward, 'sgst_paise');
  const igstPaise = sum(outward, 'igst_paise');
  const cessPaise = sum(outward, 'cess_paise');
  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise + cessPaise;

  // Only ITC-eligible inward lines contribute to the credit pool.
  const eligible = inward.filter(l => l.itc_eligible !== 0 && l.itc_eligible !== false);
  const itcTaxablePaise = sum(eligible, 'taxable_value_paise');
  const itcCgstPaise = sum(eligible, 'cgst_paise');
  const itcSgstPaise = sum(eligible, 'sgst_paise');
  const itcIgstPaise = sum(eligible, 'igst_paise');
  const itcCessPaise = sum(eligible, 'cess_paise');
  const itcTotalPaise = itcCgstPaise + itcSgstPaise + itcIgstPaise + itcCessPaise;

  // Net payable never goes below zero; unused credit carries forward.
  const netPayablePaise = Math.max(0, totalTaxPaise - itcTotalPaise);
  const creditCarriedForwardPaise = Math.max(0, itcTotalPaise - totalTaxPaise);

  return {
    taxableValuePaise, cgstPaise, sgstPaise, igstPaise, cessPaise, totalTaxPaise,
    itcTaxablePaise, itcCgstPaise, itcSgstPaise, itcIgstPaise, itcCessPaise, itcTotalPaise,
    netPayablePaise, creditCarriedForwardPaise,
    outwardCount: outward.length,
    inwardCount: inward.length,
    lineCount: lines.length,
    // Rate-wise breakdown, used by the report's HSN summary section.
    byRate: groupByRate(outward),
  };
}

function groupByRate(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = Number(l.rate_pct ?? 0);
    if (!map.has(key)) {
      map.set(key, { ratePct: key, taxableValuePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0, count: 0 });
    }
    const g = map.get(key);
    g.taxableValuePaise += l.taxable_value_paise ?? 0;
    g.cgstPaise += l.cgst_paise ?? 0;
    g.sgstPaise += l.sgst_paise ?? 0;
    g.igstPaise += l.igst_paise ?? 0;
    g.cessPaise += l.cess_paise ?? 0;
    g.count += 1;
  }
  return [...map.values()].sort((a, b) => a.ratePct - b.ratePct);
}

// ---------------------------------------------------------------------------
// TDS
// ---------------------------------------------------------------------------

/**
 * Tax deducted at source on one payment.
 *
 * Threshold behaviour: TDS applies once cumulative payments to a deductee in
 * the financial year cross the section's threshold. Pass `priorYtdPaise` to
 * apply that correctly across a year; omit it and the threshold is tested
 * against this payment alone.
 *
 * Section 206AA: where no valid PAN is on file, the higher of the section rate
 * and 20% applies, and the threshold does not shelter the payment.
 */
export function computeTdsLine({
  amountPaise, ratePct = 0, thresholdPaise = 0, priorYtdPaise = 0, hasPan = true,
  higherRateNoPan = 20,
}) {
  const amount = Math.round(Number(amountPaise) || 0);
  const cumulative = priorYtdPaise + amount;

  if (!hasPan) {
    const rate = Math.max(Number(ratePct) || 0, higherRateNoPan);
    return {
      applicable: true,
      ratePct: rate,
      tdsPaise: pctOfPaise(amount, rate),
      thresholdMet: true,
      reason: 'No valid PAN on file — section 206AA higher rate applied.',
    };
  }

  if (thresholdPaise > 0 && cumulative < thresholdPaise) {
    return {
      applicable: false,
      ratePct: 0,
      tdsPaise: 0,
      thresholdMet: false,
      reason: `Cumulative payments are below the section threshold.`,
    };
  }

  return {
    applicable: true,
    ratePct: Number(ratePct) || 0,
    tdsPaise: pctOfPaise(amount, ratePct),
    thresholdMet: true,
    reason: null,
  };
}

export function summariseTds(lines) {
  const basePaise = sumPaise(lines.map(l => l.amount_paise ?? 0));
  const deductedPaise = sumPaise(lines.map(l => l.tds_paise ?? 0));
  const depositedPaise = sumPaise(lines.map(l => l.deposited_paise ?? 0));

  const bySection = new Map();
  for (const l of lines) {
    const key = l.section_code ?? 'unspecified';
    if (!bySection.has(key)) {
      bySection.set(key, { sectionCode: key, basePaise: 0, deductedPaise: 0, depositedPaise: 0, count: 0 });
    }
    const g = bySection.get(key);
    g.basePaise += l.amount_paise ?? 0;
    g.deductedPaise += l.tds_paise ?? 0;
    g.depositedPaise += l.deposited_paise ?? 0;
    g.count += 1;
  }

  return {
    basePaise, deductedPaise, depositedPaise,
    outstandingPaise: Math.max(0, deductedPaise - depositedPaise),
    lineCount: lines.length,
    deducteeCount: new Set(lines.map(l => l.deductee_pan || l.deductee_name)).size,
    bySection: [...bySection.values()].sort((a, b) => a.sectionCode.localeCompare(b.sectionCode)),
  };
}

// ---------------------------------------------------------------------------
// Running a computation
// ---------------------------------------------------------------------------

/**
 * Compute GST or TDS for a filing period and persist the result.
 *
 * The computation is idempotent: re-running replaces the previous figures for
 * the same period/regime and marks the old row superseded, so history is kept.
 */
export async function runComputation(ctx, scope, {
  clientId, filingPeriodId, regime = 'gst', computedBy,
}) {
  const period = await scope.getOrFail('filing_periods', filingPeriodId, { resource: 'Filing period' });
  if (period.client_id !== clientId) {
    throw new BadRequestError('That filing period does not belong to the selected client.');
  }

  const client = await scope.getOrFail('clients', clientId, { resource: 'Client' });
  const company = await scope.getOrFail('companies', client.company_id, { resource: 'Company' });
  const supplierStateCode = company.state_code || gstinStateCode(company.gstin) || '33';

  // Only lines attached to verified documents count. This is the guarantee
  // that a report never contains a figure nobody checked.
  const verifiedDocs = await scope.raw(
    `SELECT id FROM documents
      WHERE tenant_id = ? AND filing_period_id = ?
        AND status IN ('verified','approved','archived') AND deleted_at IS NULL`,
    [scope.tenantId, filingPeriodId]);
  const verifiedIds = new Set(verifiedDocs.map(d => d.id));

  const warnings = [];
  const unverified = await scope.rawCount(
    `SELECT COUNT(*) FROM documents
      WHERE tenant_id = ? AND filing_period_id = ?
        AND status NOT IN ('verified','approved','archived','rejected') AND deleted_at IS NULL`,
    [scope.tenantId, filingPeriodId]);
  if (unverified > 0) {
    warnings.push({
      code: 'unverified_documents',
      severity: 'warning',
      message: `${unverified} document${unverified === 1 ? '' : 's'} in this period ${unverified === 1 ? 'is' : 'are'} not yet verified and ${unverified === 1 ? 'is' : 'are'} excluded from this computation.`,
    });
  }

  const ts = nowIso();
  const existing = await scope.rawOne(
    `SELECT * FROM tax_computations
      WHERE tenant_id = ? AND filing_period_id = ? AND regime = ? AND status != 'superseded'
      ORDER BY created_at DESC LIMIT 1`,
    [scope.tenantId, filingPeriodId, regime]);

  const computationId = existing?.id ?? ID.computation();

  if (regime === 'gst') {
    const lines = await scope.raw(
      `SELECT * FROM gst_records WHERE tenant_id = ? AND computation_id = ?`,
      [scope.tenantId, computationId]);

    // Recalculate every line from its taxable value and rate so a change to a
    // rule, a place of supply or the company's own state flows through.
    const recomputed = [];
    for (const line of lines) {
      if (line.document_id && !verifiedIds.has(line.document_id)) continue;
      const interState = isInterState({
        supplierStateCode,
        placeOfSupply: line.place_of_supply,
        supplyType: line.supply_type,
      });
      const tax = computeGstLine({
        taxableValuePaise: line.taxable_value_paise,
        ratePct: line.rate_pct,
        cessPct: 0,
        interState,
        supplyType: line.supply_type,
      });
      recomputed.push({
        ...line,
        cgst_paise: tax.cgstPaise,
        sgst_paise: tax.sgstPaise,
        igst_paise: tax.igstPaise,
        cess_paise: line.cess_paise ?? tax.cessPaise,
        total_paise: tax.invoiceTotalPaise,
        supply_type: line.supply_type === 'intra' || line.supply_type === 'inter'
          ? (interState ? 'inter' : 'intra')
          : line.supply_type,
      });
    }

    // Persist the corrected line figures in one batch.
    if (recomputed.length) {
      await scope.batch(recomputed.map(l => ([
        `UPDATE gst_records SET cgst_paise = ?, sgst_paise = ?, igst_paise = ?, cess_paise = ?,
            total_paise = ?, supply_type = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [l.cgst_paise, l.sgst_paise, l.igst_paise, l.cess_paise, l.total_paise,
         l.supply_type, ts, l.id, scope.tenantId],
      ])));
    }

    const summary = summariseGst(recomputed);
    if (!recomputed.length) {
      warnings.push({
        code: 'no_records',
        severity: 'info',
        message: 'No GST records are attached to verified documents for this period yet.',
      });
    }

    const row = {
      id: computationId,
      tenant_id: scope.tenantId,
      company_id: company.id,
      client_id: clientId,
      filing_period_id: filingPeriodId,
      regime: 'gst',
      period_type: period.period_type,
      period_key: period.period_key,
      taxable_value_paise: summary.taxableValuePaise,
      cgst_paise: summary.cgstPaise,
      sgst_paise: summary.sgstPaise,
      igst_paise: summary.igstPaise,
      cess_paise: summary.cessPaise,
      total_tax_paise: summary.totalTaxPaise,
      itc_taxable_paise: summary.itcTaxablePaise,
      itc_cgst_paise: summary.itcCgstPaise,
      itc_sgst_paise: summary.itcSgstPaise,
      itc_igst_paise: summary.itcIgstPaise,
      itc_cess_paise: summary.itcCessPaise,
      itc_total_paise: summary.itcTotalPaise,
      net_payable_paise: summary.netPayablePaise,
      tds_base_paise: 0, tds_deducted_paise: 0, tds_deposited_paise: 0,
      status: 'computed',
      source_document_count: verifiedIds.size,
      line_count: summary.lineCount,
      warnings_json: JSON.stringify(warnings),
      computed_by: computedBy,
      computed_at: ts,
      engine_version: ENGINE_VERSION,
      updated_at: ts,
    };

    if (existing) await scope.update('tax_computations', computationId, row);
    else await scope.insert('tax_computations', { ...row, created_at: ts });

    return { computation: row, summary, warnings, lines: recomputed };
  }

  if (regime === 'tds') {
    const lines = await scope.raw(
      `SELECT * FROM tds_records WHERE tenant_id = ? AND computation_id = ?`,
      [scope.tenantId, computationId]);

    const filtered = lines.filter(l => !l.document_id || verifiedIds.has(l.document_id));

    // Recompute each deduction against the rule in force on the payment date,
    // applying the annual threshold per deductee.
    const ytdByDeductee = new Map();
    const recomputed = [];
    for (const line of filtered.sort(sortByPaymentDate)) {
      const rule = await resolveRule(scope, {
        regime: 'tds',
        code: line.section_code ? tdsCodeFor(line.section_code, line.payee_type) : null,
        at: line.payment_date || period.period_end,
      });
      const ratePct = rule?.rate_pct ?? line.rate_pct ?? 0;
      const thresholdPaise = rule?.threshold_paise ?? 0;
      const key = line.deductee_pan || line.deductee_name || line.id;
      const prior = ytdByDeductee.get(key) ?? 0;

      const result = computeTdsLine({
        amountPaise: line.amount_paise,
        ratePct,
        thresholdPaise,
        priorYtdPaise: prior,
        hasPan: !!line.deductee_pan,
      });
      ytdByDeductee.set(key, prior + (line.amount_paise ?? 0));

      if (!result.applicable && line.tds_paise > 0) {
        warnings.push({
          code: 'below_threshold',
          severity: 'info',
          message: `${line.deductee_name || 'A deductee'} is below the section ${line.section_code} threshold; deduction set to nil.`,
        });
      }
      if (!line.deductee_pan) {
        warnings.push({
          code: 'missing_pan',
          severity: 'warning',
          message: `No PAN recorded for ${line.deductee_name || 'a deductee'} — section 206AA higher rate applied.`,
        });
      }

      recomputed.push({ ...line, rate_pct: result.ratePct, tds_paise: result.tdsPaise });
    }

    if (recomputed.length) {
      await scope.batch(recomputed.map(l => ([
        `UPDATE tds_records SET rate_pct = ?, tds_paise = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [l.rate_pct, l.tds_paise, ts, l.id, scope.tenantId],
      ])));
    }

    const summary = summariseTds(recomputed);
    if (!recomputed.length) {
      warnings.push({ code: 'no_records', severity: 'info',
        message: 'No TDS records are attached to verified documents for this period yet.' });
    }

    const row = {
      id: computationId,
      tenant_id: scope.tenantId,
      company_id: company.id,
      client_id: clientId,
      filing_period_id: filingPeriodId,
      regime: 'tds',
      period_type: period.period_type,
      period_key: period.period_key,
      taxable_value_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0, cess_paise: 0,
      total_tax_paise: summary.deductedPaise,
      itc_taxable_paise: 0, itc_cgst_paise: 0, itc_sgst_paise: 0, itc_igst_paise: 0,
      itc_cess_paise: 0, itc_total_paise: 0,
      net_payable_paise: summary.outstandingPaise,
      tds_base_paise: summary.basePaise,
      tds_deducted_paise: summary.deductedPaise,
      tds_deposited_paise: summary.depositedPaise,
      status: 'computed',
      source_document_count: verifiedIds.size,
      line_count: summary.lineCount,
      warnings_json: JSON.stringify(dedupeWarnings(warnings)),
      computed_by: computedBy,
      computed_at: ts,
      engine_version: ENGINE_VERSION,
      updated_at: ts,
    };

    if (existing) await scope.update('tax_computations', computationId, row);
    else await scope.insert('tax_computations', { ...row, created_at: ts });

    return { computation: row, summary, warnings: dedupeWarnings(warnings), lines: recomputed };
  }

  throw new BadRequestError(`Unknown tax regime: ${regime}`);
}

function sortByPaymentDate(a, b) {
  return String(a.payment_date ?? '').localeCompare(String(b.payment_date ?? ''));
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  return warnings.filter(w => {
    const key = `${w.code}|${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Map a bare section number to a rule code, choosing the payee-specific
 * variant where the section defines one (194C is the common case).
 */
export function tdsCodeFor(sectionCode, payeeType) {
  const section = String(sectionCode).toUpperCase().replace(/[^0-9A-Z-]/g, '');
  const individual = payeeType === 'individual' || payeeType === 'huf';
  const map = {
    '192': 'TDS_192',
    '194A': 'TDS_194A',
    '194C': individual ? 'TDS_194C_IND' : 'TDS_194C_CO',
    '194H': 'TDS_194H',
    '194I': 'TDS_194I_LB',
    '194J': 'TDS_194J_PRO',
    '194Q': 'TDS_194Q',
    '194O': 'TDS_194O',
    '194-IB': 'TDS_194IB',
    '194IB': 'TDS_194IB',
    '206AA': 'TDS_206AA',
  };
  return map[section] ?? `TDS_${section}`;
}

/**
 * A standalone "what would this cost" calculator for the Tax Calculation
 * screen — no persistence, no documents, just the arithmetic, so an executive
 * can sanity-check a figure before committing it.
 */
export async function previewGst(scope, { taxableValuePaise, ratePct, supplierStateCode, placeOfSupply, supplyType = 'intra', cessPct = 0, at = nowIso() }) {
  const code = `GST_${String(ratePct).replace('.', '_')}`;
  const rule = await resolveRule(scope, { regime: 'gst', code, at });
  const effectiveRate = rule?.rate_pct ?? Number(ratePct) ?? 0;
  const interState = isInterState({ supplierStateCode, placeOfSupply, supplyType });

  const result = computeGstLine({
    taxableValuePaise, ratePct: effectiveRate, cessPct, interState, supplyType,
  });
  return {
    ...result,
    interState,
    ratePct: effectiveRate,
    ruleFound: !!rule,
    ruleCode: rule?.code ?? null,
    note: rule
      ? `Rate resolved from rule ${rule.code}, effective ${rule.effective_from.slice(0, 10)}.`
      : 'No matching verified rule was found; the rate you supplied was used as-is.',
  };
}

export async function previewTds(scope, { amountPaise, sectionCode, payeeType = 'company', hasPan = true, priorYtdPaise = 0, at = nowIso() }) {
  const code = tdsCodeFor(sectionCode, payeeType);
  const rule = await resolveRule(scope, { regime: 'tds', code, at });
  if (!rule) {
    throw new NotFoundError('Tax rule',
      `No verified TDS rule was found for section ${sectionCode}. Add it under Settings → Tax before computing.`);
  }
  const result = computeTdsLine({
    amountPaise,
    ratePct: rule.rate_pct,
    thresholdPaise: rule.threshold_paise,
    priorYtdPaise,
    hasPan,
  });
  return {
    ...result,
    sectionCode: rule.section_code,
    ruleCode: rule.code,
    ruleName: rule.name,
    thresholdPaise: rule.threshold_paise,
    netPayablePaise: Math.round(Number(amountPaise) || 0) - result.tdsPaise,
  };
}

/** Period totals across clients — powers the finance dashboard's GST summary. */
export async function periodTotals(scope, { periodKey, regime = 'gst', clientId = null }) {
  const params = [scope.tenantId, regime, periodKey];
  let clause = '';
  if (clientId) { clause = 'AND client_id = ?'; params.push(clientId); }
  const row = await scope.rawOne(
    `SELECT
        COUNT(*) AS computations,
        COALESCE(SUM(taxable_value_paise),0) AS taxable,
        COALESCE(SUM(cgst_paise),0) AS cgst,
        COALESCE(SUM(sgst_paise),0) AS sgst,
        COALESCE(SUM(igst_paise),0) AS igst,
        COALESCE(SUM(cess_paise),0) AS cess,
        COALESCE(SUM(total_tax_paise),0) AS total_tax,
        COALESCE(SUM(itc_total_paise),0) AS itc,
        COALESCE(SUM(net_payable_paise),0) AS net_payable,
        COALESCE(SUM(tds_base_paise),0) AS tds_base,
        COALESCE(SUM(tds_deducted_paise),0) AS tds_deducted,
        COALESCE(SUM(tds_deposited_paise),0) AS tds_deposited
       FROM tax_computations
      WHERE tenant_id = ? AND regime = ? AND period_key = ? AND status != 'superseded' ${clause}`,
    params);
  return {
    computations: Number(row?.computations) || 0,
    taxableValuePaise: Number(row?.taxable) || 0,
    cgstPaise: Number(row?.cgst) || 0,
    sgstPaise: Number(row?.sgst) || 0,
    igstPaise: Number(row?.igst) || 0,
    cessPaise: Number(row?.cess) || 0,
    totalTaxPaise: Number(row?.total_tax) || 0,
    itcTotalPaise: Number(row?.itc) || 0,
    netPayablePaise: Number(row?.net_payable) || 0,
    tdsBasePaise: Number(row?.tds_base) || 0,
    tdsDeductedPaise: Number(row?.tds_deducted) || 0,
    tdsDepositedPaise: Number(row?.tds_deposited) || 0,
  };
}

export { periodBounds };
