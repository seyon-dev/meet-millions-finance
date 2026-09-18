/**
 * The AI module layer — OCR extraction, document pre-screening, the GST/TDS
 * assistant, and business insights.
 *
 * Three rules hold across all of it:
 *
 *  1. Every AI result is stored with a confidence score and a review state.
 *     Nothing is applied to a tax record until a human accepts it.
 *  2. The tax assistant is given the tenant's *verified* rules and computed
 *     figures as context and is instructed never to state a rate it was not
 *     given. Anything it does say is labelled as a suggestion, and the reply
 *     carries `isVerifiedData: false` unless it is quoting a stored figure.
 *  3. With no ANTHROPIC_API_KEY or GOOGLE_VISION_API_KEY configured, these
 *     functions record `not_configured` and return — they never fabricate.
 */

import { VisionOcrProvider, SpeechProvider, ClaudeProvider } from '../integrations/ai.js';
import { getObject } from './storage.js';
import { ID } from '../utils/id.js';
import { nowIso, monthKey } from '../utils/time.js';
import { formatINR, toPaise } from '../utils/money.js';
import { isGstin, isPan } from '../utils/validate.js';
import { listRules } from './tax-engine.js';

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

/**
 * Run OCR on a document's current version and store the extraction for review.
 * Safe to call unconditionally: with no credentials it records the fact.
 */
export async function queueOcr(ctx, scope, document, documentType) {
  const profile = documentType?.ocr_profile && documentType.ocr_profile !== 'none'
    ? documentType.ocr_profile
    : null;

  if (!profile) {
    await scope.update('documents', document.id, { ocr_status: 'skipped' });
    return { skipped: true, reason: 'This document type is not set up for OCR.' };
  }

  const provider = new VisionOcrProvider(ctx.env);
  const extractionId = ID.ocr();

  const base = {
    id: extractionId,
    document_id: document.id,
    version_id: document.current_version_id,
    profile,
    provider: provider.key,
    review_status: 'pending',
    applied_to_records: 0,
  };

  if (!provider.isConfigured()) {
    await scope.insert('ocr_extractions', {
      ...base,
      status: 'not_configured',
      error_message: `Not connected. Missing: ${provider.missingKeys().join(', ')}.`,
    });
    await scope.update('documents', document.id, { ocr_status: 'skipped' });
    return { configured: false, missingKeys: provider.missingKeys() };
  }

  await scope.insert('ocr_extractions', { ...base, status: 'processing' });
  await scope.update('documents', document.id, { ocr_status: 'processing' });

  const version = await scope.first('document_versions', { id: document.current_version_id });
  const started = Date.now();

  try {
    const object = await getObject(ctx.env, version.storage_key);
    const result = await provider.extract(await object.arrayBuffer(), profile);

    if (!result.ok) {
      await scope.update('ocr_extractions', extractionId, {
        status: 'failed', error_message: result.error?.message ?? 'OCR failed.',
        duration_ms: Date.now() - started,
      });
      await scope.update('documents', document.id, { ocr_status: 'failed' });
      return { ok: false, error: result.error };
    }

    await scope.update('ocr_extractions', extractionId, {
      status: 'done',
      overall_confidence: result.data.overallConfidence,
      fields_json: JSON.stringify(result.data.fields),
      raw_text: String(result.data.text).slice(0, 40000),
      duration_ms: Date.now() - started,
    });
    await scope.update('documents', document.id, {
      ocr_status: 'done',
      ai_confidence: result.data.overallConfidence,
    });

    return { ok: true, extractionId, fields: result.data.fields, confidence: result.data.overallConfidence };
  } catch (err) {
    await scope.update('ocr_extractions', extractionId, {
      status: 'failed', error_message: err.message, duration_ms: Date.now() - started,
    });
    await scope.update('documents', document.id, { ocr_status: 'failed' });
    return { ok: false, error: { message: err.message } };
  }
}

/**
 * Apply reviewed OCR fields to a GST record. Only called after a human has
 * accepted (and possibly corrected) the extraction.
 */
export async function applyOcrToGstRecord(ctx, scope, { extraction, document, fields, computationId }) {
  const byKey = Object.fromEntries(fields.map(f => [f.key, f.value]));
  const taxable = toPaise(String(byKey.taxable_value ?? '0').replace(/,/g, ''));
  const cgst = toPaise(String(byKey.cgst ?? '0').replace(/,/g, ''));
  const sgst = toPaise(String(byKey.sgst ?? '0').replace(/,/g, ''));
  const igst = toPaise(String(byKey.igst ?? '0').replace(/,/g, ''));
  const total = toPaise(String(byKey.total ?? '0').replace(/,/g, ''));

  const ratePct = taxable > 0 ? Number((((cgst + sgst + igst) / taxable) * 100).toFixed(2)) : 0;

  const record = await scope.insert('gst_records', {
    id: ID.gstRecord(),
    computation_id: computationId,
    client_id: document.client_id,
    document_id: document.id,
    direction: 'outward',
    supply_type: igst > 0 ? 'inter' : 'intra',
    invoice_no: byKey.invoice_no ?? null,
    invoice_date: normaliseDate(byKey.invoice_date),
    counterparty_gstin: isGstin(byKey.supplier_gstin ?? '') ? byKey.supplier_gstin : null,
    place_of_supply: byKey.place_of_supply ?? null,
    taxable_value_paise: taxable,
    rate_pct: ratePct,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    cess_paise: 0,
    total_paise: total || taxable + cgst + sgst + igst,
    itc_eligible: 1,
    source: 'ocr',
    ocr_confidence: extraction.overall_confidence,
  });

  await scope.update('ocr_extractions', extraction.id, {
    applied_to_records: 1,
    review_status: 'accepted',
    reviewed_by: ctx.userId,
    reviewed_at: nowIso(),
  });

  return record;
}

function normaliseDate(value) {
  if (!value) return null;
  const m = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(String(value));
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? `20${y}` : y;
  const iso = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : `${iso}T00:00:00.000Z`;
}

// ---------------------------------------------------------------------------
// AI document verification (pre-screening)
// ---------------------------------------------------------------------------

/**
 * Pre-screen a document for completeness and consistency.
 *
 * The deterministic checks (missing fields, GSTIN/PAN validity, arithmetic)
 * run first and always — they need no vendor. When Claude is configured it
 * adds a cross-document consistency reading on top.
 */
export async function queueAiPrecheck(ctx, scope, document) {
  const verificationId = ID.aiVerify();
  await scope.insert('ai_verifications', {
    id: verificationId,
    document_id: document.id,
    version_id: document.current_version_id,
    status: 'processing',
    flag_count: 0,
  });
  await scope.update('documents', document.id, { ai_precheck_status: 'processing' });

  const checks = [];
  const flags = [];

  const version = await scope.first('document_versions', { id: document.current_version_id });

  // --- Deterministic checks -------------------------------------------------
  checks.push({
    check: 'file_readable',
    result: version && version.size_bytes > 0 ? 'pass' : 'fail',
    detail: version ? `${version.size_bytes} bytes stored.` : 'No stored file found.',
  });
  if (!version || version.size_bytes === 0) {
    flags.push({ severity: 'critical', code: 'empty_file', message: 'The stored file is empty.' });
  }

  const tiny = version && version.size_bytes < 8 * 1024;
  checks.push({
    check: 'file_size_plausible',
    result: tiny ? 'warn' : 'pass',
    detail: tiny ? 'The file is unusually small for a financial document.' : 'File size looks normal.',
  });
  if (tiny) {
    flags.push({ severity: 'warning', code: 'suspiciously_small', message: 'This file is very small — it may be a blank page or a partial scan.' });
  }

  // Duplicate detection by checksum across the client's documents.
  if (version?.checksum_sha256) {
    const duplicate = await scope.rawOne(
      `SELECT dv.document_id, d.title FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
        WHERE dv.tenant_id = ? AND dv.checksum_sha256 = ? AND dv.document_id != ?
          AND d.client_id = ? AND d.deleted_at IS NULL LIMIT 1`,
      [scope.tenantId, version.checksum_sha256, document.id, document.client_id]);
    checks.push({
      check: 'duplicate_detection',
      result: duplicate ? 'fail' : 'pass',
      detail: duplicate ? `Byte-identical to "${duplicate.title}".` : 'No identical file found for this client.',
    });
    if (duplicate) {
      flags.push({
        severity: 'critical', code: 'duplicate_upload',
        message: `This file is byte-identical to "${duplicate.title}" already on file.`,
      });
    }
  }

  // Field-level checks against any OCR output we have.
  const ocr = await scope.rawOne(
    `SELECT * FROM ocr_extractions WHERE tenant_id = ? AND document_id = ? AND status = 'done'
      ORDER BY created_at DESC LIMIT 1`, [scope.tenantId, document.id]);

  if (ocr) {
    const fields = safeJson(ocr.fields_json, []);
    const missing = fields.filter(f => !f.value).map(f => f.label);
    checks.push({
      check: 'required_fields_present',
      result: missing.length ? 'warn' : 'pass',
      detail: missing.length ? `Could not read: ${missing.join(', ')}.` : 'All expected fields were read.',
    });
    if (missing.length) {
      flags.push({
        severity: 'warning', code: 'missing_fields',
        message: `${missing.length} expected field${missing.length === 1 ? '' : 's'} could not be read: ${missing.join(', ')}.`,
      });
    }

    const byKey = Object.fromEntries(fields.map(f => [f.key, f.value]));

    if (byKey.supplier_gstin) {
      const valid = isGstin(byKey.supplier_gstin);
      checks.push({ check: 'gstin_checksum', result: valid ? 'pass' : 'fail',
        detail: valid ? 'GSTIN checksum is valid.' : `GSTIN "${byKey.supplier_gstin}" fails its checksum.` });
      if (!valid) flags.push({ severity: 'critical', code: 'invalid_gstin', message: `The GSTIN read from this document (${byKey.supplier_gstin}) is not valid.` });
    }
    if (byKey.pan) {
      const valid = isPan(byKey.pan);
      checks.push({ check: 'pan_format', result: valid ? 'pass' : 'fail',
        detail: valid ? 'PAN format is valid.' : `PAN "${byKey.pan}" is not in the expected format.` });
      if (!valid) flags.push({ severity: 'critical', code: 'invalid_pan', message: `The PAN read from this document is not in the expected format.` });
    }

    // Arithmetic: taxable + tax should equal the stated total.
    const taxable = num(byKey.taxable_value);
    const taxSum = num(byKey.cgst) + num(byKey.sgst) + num(byKey.igst);
    const total = num(byKey.total);
    if (taxable && total) {
      const expected = taxable + taxSum;
      const drift = Math.abs(expected - total);
      const tolerant = drift <= Math.max(1, total * 0.01);
      checks.push({
        check: 'invoice_arithmetic',
        result: tolerant ? 'pass' : 'fail',
        detail: tolerant
          ? 'Taxable value plus tax matches the stated total.'
          : `Taxable (${taxable}) + tax (${taxSum}) = ${expected}, but the total reads ${total}.`,
      });
      if (!tolerant) {
        flags.push({
          severity: 'critical', code: 'arithmetic_mismatch',
          message: `The invoice total does not match taxable value plus tax — a difference of ${formatINR(toPaise(drift))}.`,
        });
      }
    }

    // Cross-document: has this invoice number already been filed this period?
    if (byKey.invoice_no) {
      const seen = await scope.rawOne(
        `SELECT g.id, d.title FROM gst_records g
           JOIN documents d ON d.id = g.document_id
          WHERE g.tenant_id = ? AND g.client_id = ? AND g.invoice_no = ? AND g.document_id != ?
          LIMIT 1`, [scope.tenantId, document.client_id, byKey.invoice_no, document.id]);
      checks.push({
        check: 'invoice_number_unique',
        result: seen ? 'warn' : 'pass',
        detail: seen ? `Invoice ${byKey.invoice_no} also appears on "${seen.title}".` : 'Invoice number not seen elsewhere.',
      });
      if (seen) {
        flags.push({
          severity: 'warning', code: 'duplicate_invoice_number',
          message: `Invoice number ${byKey.invoice_no} is already recorded against "${seen.title}".`,
        });
      }
    }
  } else {
    checks.push({
      check: 'ocr_available',
      result: 'skip',
      detail: 'No OCR output to cross-check. Field-level checks were skipped.',
    });
  }

  // --- Model-assisted consistency reading ----------------------------------
  const claude = new ClaudeProvider(ctx.env);
  let modelConfidence = null;

  if (claude.isConfigured() && ocr) {
    const result = await claude.complete({
      system: [
        'You are reviewing a scanned Indian financial document that has already passed deterministic checks.',
        'You will be given only the OCR text. Judge completeness and internal consistency.',
        'Do NOT assert tax rates, statutory thresholds or legal conclusions — you are not given the rule book.',
        'If something is merely unclear, say so rather than guessing.',
      ].join(' '),
      messages: [{
        role: 'user',
        content: `Document type: ${ocr.profile}\n\nOCR text (truncated):\n${String(ocr.raw_text ?? '').slice(0, 6000)}`,
      }],
      jsonSchema: {
        confidence: 'number between 0 and 1',
        recommendation: 'one of: pre_approve, review, reject',
        observations: ['short strings describing what you noticed'],
        concerns: [{ severity: 'warning|critical', message: 'string' }],
      },
      maxTokens: 900,
    });

    if (result.ok && result.data.json) {
      const json = result.data.json;
      modelConfidence = typeof json.confidence === 'number' ? json.confidence : null;
      checks.push({
        check: 'model_consistency_review',
        result: json.recommendation === 'reject' ? 'fail' : json.recommendation === 'review' ? 'warn' : 'pass',
        detail: (json.observations ?? []).join(' ') || 'No observations returned.',
      });
      for (const concern of json.concerns ?? []) {
        flags.push({
          severity: concern.severity === 'critical' ? 'critical' : 'warning',
          code: 'model_concern',
          message: String(concern.message).slice(0, 400),
          source: 'ai',
        });
      }
    } else {
      checks.push({
        check: 'model_consistency_review',
        result: 'skip',
        detail: result.error?.message ?? 'The model review did not complete.',
      });
    }
  } else if (!claude.isConfigured()) {
    checks.push({
      check: 'model_consistency_review',
      result: 'skip',
      detail: 'Claude API is not connected; deterministic checks only.',
    });
  }

  // --- Verdict --------------------------------------------------------------
  const critical = flags.filter(f => f.severity === 'critical').length;
  const status = flags.length === 0 ? 'clean' : 'flagged';
  const recommendation = critical > 0 ? 'reject' : flags.length > 0 ? 'review' : 'pre_approve';

  const passed = checks.filter(c => c.result === 'pass').length;
  const scored = checks.filter(c => c.result !== 'skip').length;
  const deterministicConfidence = scored ? passed / scored : 0.5;
  const confidence = modelConfidence !== null
    ? Number(((deterministicConfidence + modelConfidence) / 2).toFixed(3))
    : Number(deterministicConfidence.toFixed(3));

  await scope.update('ai_verifications', verificationId, {
    status,
    confidence,
    checks_json: JSON.stringify(checks),
    flags_json: JSON.stringify(flags),
    flag_count: flags.length,
    recommendation,
    provider: claude.isConfigured() ? 'anthropic+rules' : 'rules',
  });
  await scope.update('documents', document.id, {
    ai_precheck_status: status,
    ai_confidence: confidence,
  });

  return { verificationId, status, confidence, recommendation, checks, flags };
}

// ---------------------------------------------------------------------------
// GST & Tax assistant
// ---------------------------------------------------------------------------

const ASSISTANT_SYSTEM = [
  'You are the GST and TDS assistant inside Meet Millions Finance CRM, helping a qualified finance executive in India.',
  '',
  'Ground rules you must follow exactly:',
  '1. The only tax rates and thresholds you may state are the ones supplied to you in the VERIFIED TAX RULES block. If a rate you need is not there, say so plainly and tell the user to add it under Settings → Tax. Never recall a rate from memory.',
  '2. The only client figures you may quote are the ones in the CLIENT CONTEXT block. Never invent an amount.',
  '3. When you reason beyond the supplied data, label it clearly as a suggestion to be checked, not a determination.',
  '4. Be concise and practical. Use Indian numbering (₹1,23,456) and name the section or rule code you relied on.',
  '5. You are not a substitute for professional judgement, and you never file anything.',
].join('\n');

/**
 * Answer a question with the tenant's verified rules and the client's computed
 * figures as the only factual ground.
 */
export async function askTaxAssistant(ctx, scope, {
  conversationId, question, clientId = null, filingPeriodId = null,
}) {
  const claude = new ClaudeProvider(ctx.env);

  if (!claude.isConfigured()) {
    return {
      ok: false,
      configured: false,
      missingKeys: claude.missingKeys(),
      message: 'The AI GST & Tax Assistant is not connected. Add ANTHROPIC_API_KEY in Settings → Integrations to enable it.',
    };
  }

  const rules = await listRules(scope, {});
  const verifiedRules = rules.filter(r => r.is_verified);

  const rulesBlock = verifiedRules.map(r =>
    r.regime === 'gst'
      ? `${r.code} | GST | ${r.name} | total ${r.rate_pct}% (CGST ${r.cgst_pct}%, SGST ${r.sgst_pct}%, IGST ${r.igst_pct}%) | effective from ${r.effective_from.slice(0, 10)}`
      : `${r.code} | TDS §${r.section_code} | ${r.name} | ${r.rate_pct}% | threshold ${formatINR(r.threshold_paise)} | payee ${r.payee_type ?? 'any'} | effective from ${r.effective_from.slice(0, 10)}`
  ).join('\n');

  let contextBlock = 'No specific client selected.';
  const citations = [];

  if (clientId) {
    const client = await scope.first('clients', { id: clientId });
    const company = client ? await scope.first('companies', { id: client.company_id }) : null;
    const computations = await scope.raw(
      `SELECT * FROM tax_computations
        WHERE tenant_id = ? AND client_id = ? AND status != 'superseded'
        ORDER BY period_key DESC LIMIT 6`, [scope.tenantId, clientId]);

    if (client) {
      contextBlock = [
        `Client: ${client.display_name} (${client.client_code})`,
        `Company: ${company?.name ?? 'n/a'} | GSTIN: ${company?.gstin ?? 'not on file'} | State code: ${company?.state_code ?? 'n/a'}`,
        `Registration: ${company?.gst_registration_type ?? 'regular'} | Filing frequency: ${company?.gst_filing_frequency ?? 'monthly'}`,
        '',
        'Computed figures on file (these are verified, from reviewed documents):',
        ...computations.map(c => c.regime === 'gst'
          ? `  ${c.period_key} GST — taxable ${formatINR(c.taxable_value_paise)}, CGST ${formatINR(c.cgst_paise)}, SGST ${formatINR(c.sgst_paise)}, IGST ${formatINR(c.igst_paise)}, ITC ${formatINR(c.itc_total_paise)}, net payable ${formatINR(c.net_payable_paise)} (from ${c.line_count} lines across ${c.source_document_count} verified documents)`
          : `  ${c.period_key} TDS — base ${formatINR(c.tds_base_paise)}, deducted ${formatINR(c.tds_deducted_paise)}, deposited ${formatINR(c.tds_deposited_paise)}`),
      ].join('\n');

      for (const c of computations) {
        citations.push({ type: 'computation', id: c.id, period: c.period_key, regime: c.regime });
      }
    }
  }

  const history = conversationId
    ? await scope.raw(
        `SELECT role, content FROM ai_messages
          WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at ASC LIMIT 20`,
        [scope.tenantId, conversationId])
    : [];

  const messages = [
    ...history.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `VERIFIED TAX RULES\n${rulesBlock || '(none configured)'}\n\nCLIENT CONTEXT\n${contextBlock}\n\nQUESTION\n${question}`,
    },
  ];

  const result = await claude.complete({
    system: ASSISTANT_SYSTEM,
    messages,
    maxTokens: 1600,
    temperature: 0.15,
  });

  if (!result.ok) {
    return { ok: false, configured: true, error: result.error };
  }

  return {
    ok: true,
    configured: true,
    answer: result.data.text,
    model: result.data.model,
    tokensIn: result.data.tokensIn,
    tokensOut: result.data.tokensOut,
    latencyMs: result.data.latencyMs,
    citations,
    // The answer is grounded in verified figures only when we supplied some.
    isVerifiedData: citations.length > 0,
    disclaimer: citations.length
      ? 'Figures quoted above come from computed records in this CRM. Rate guidance is drawn from your configured, verified tax rules. Review before filing.'
      : 'This answer is a suggestion generated from your configured tax rules. No client figures were supplied to it. Review before acting.',
  };
}

/** Draft a filing summary from computed figures — always marked as a draft. */
export async function draftFilingSummary(ctx, scope, { computation, client, company, lines = [] }) {
  const claude = new ClaudeProvider(ctx.env);
  if (!claude.isConfigured()) {
    return { ok: false, configured: false, missingKeys: claude.missingKeys() };
  }

  const figures = [
    `Period: ${computation.period_key} (${computation.period_type})`,
    `Taxable value: ${formatINR(computation.taxable_value_paise)}`,
    `CGST: ${formatINR(computation.cgst_paise)} | SGST: ${formatINR(computation.sgst_paise)} | IGST: ${formatINR(computation.igst_paise)} | Cess: ${formatINR(computation.cess_paise)}`,
    `Total output tax: ${formatINR(computation.total_tax_paise)}`,
    `Input tax credit: ${formatINR(computation.itc_total_paise)}`,
    `Net payable: ${formatINR(computation.net_payable_paise)}`,
    `Built from ${computation.line_count} lines across ${computation.source_document_count} verified documents.`,
  ].join('\n');

  const result = await claude.complete({
    system: [
      'You draft concise GST filing summaries for an Indian accounting firm to review before filing.',
      'Use only the figures supplied. Do not compute new numbers, do not state rates, do not speculate.',
      'Write four short paragraphs: what the period covers, the output tax position, the credit position, and anything the reviewer should check.',
      'Plain professional English. Indian number formatting.',
    ].join(' '),
    messages: [{
      role: 'user',
      content: `Client: ${client.display_name}\nCompany: ${company?.name ?? ''} (GSTIN ${company?.gstin ?? 'not on file'})\n\n${figures}`,
    }],
    maxTokens: 900,
    temperature: 0.2,
  });

  if (!result.ok) return { ok: false, configured: true, error: result.error };

  return {
    ok: true,
    configured: true,
    narrative: result.data.text,
    model: result.data.model,
    disclaimer: 'Draft generated from the computed figures above. A reviewer must confirm it before the report is approved.',
  };
}

// ---------------------------------------------------------------------------
// Call AI — summary, sentiment, action items
// ---------------------------------------------------------------------------

export async function analyseCall(ctx, scope, { call, transcript }) {
  const claude = new ClaudeProvider(ctx.env);
  const analysisId = ID.callAi();

  if (!claude.isConfigured()) {
    await scope.insert('call_ai_analysis', {
      id: analysisId, call_id: call.id, status: 'not_configured',
      error_message: `Not connected. Missing: ${claude.missingKeys().join(', ')}.`,
    });
    return { ok: false, configured: false };
  }

  if (!transcript?.full_text) {
    await scope.insert('call_ai_analysis', {
      id: analysisId, call_id: call.id, status: 'failed',
      error_message: 'No transcript is available for this call.',
    });
    return { ok: false, configured: true, error: { message: 'No transcript available.' } };
  }

  await scope.insert('call_ai_analysis', { id: analysisId, call_id: call.id, status: 'processing' });

  const result = await claude.complete({
    system: [
      'You summarise business calls between an Indian accounting firm and its clients.',
      'Be factual and brief. Only describe what was actually said. Do not infer commitments that were not made.',
    ].join(' '),
    messages: [{ role: 'user', content: `Call transcript:\n\n${String(transcript.full_text).slice(0, 12000)}` }],
    jsonSchema: {
      summary: 'two or three sentences',
      keyPoints: ['short strings'],
      actionItems: [{ owner: 'client|firm', description: 'string', dueHint: 'string or null' }],
      sentiment: 'one of: positive, neutral, negative, mixed',
      sentimentScore: 'number between -1 and 1',
      topics: ['short topic labels'],
      nextStep: 'one sentence, or null',
    },
    maxTokens: 1200,
    temperature: 0.2,
  });

  if (!result.ok || !result.data.json) {
    await scope.update('call_ai_analysis', analysisId, {
      status: 'failed', error_message: result.error?.message ?? 'The model did not return usable output.',
    });
    return { ok: false, configured: true, error: result.error };
  }

  const json = result.data.json;
  await scope.update('call_ai_analysis', analysisId, {
    status: 'done',
    summary: String(json.summary ?? '').slice(0, 2000),
    key_points_json: JSON.stringify(json.keyPoints ?? []),
    action_items_json: JSON.stringify(json.actionItems ?? []),
    sentiment: ['positive', 'neutral', 'negative', 'mixed'].includes(json.sentiment) ? json.sentiment : 'neutral',
    sentiment_score: typeof json.sentimentScore === 'number' ? json.sentimentScore : null,
    topics_json: JSON.stringify(json.topics ?? []),
    next_step: json.nextStep ? String(json.nextStep).slice(0, 500) : null,
    model: result.data.model,
    confidence: 0.8,
  });

  return { ok: true, configured: true, analysisId, analysis: json };
}

// ---------------------------------------------------------------------------
// Voice note transcription
// ---------------------------------------------------------------------------

export async function transcribeVoiceNote(ctx, scope, voiceNote) {
  const provider = new SpeechProvider(ctx.env);

  if (!provider.isConfigured()) {
    await scope.update('voice_notes', voiceNote.id, {
      transcript_status: 'not_configured',
    });
    return { ok: false, configured: false, missingKeys: provider.missingKeys() };
  }

  await scope.update('voice_notes', voiceNote.id, { transcript_status: 'processing' });

  try {
    const object = await getObject(ctx.env, voiceNote.storage_key);
    const encoding = voiceNote.mime_type?.includes('webm') ? 'WEBM_OPUS'
      : voiceNote.mime_type?.includes('ogg') ? 'OGG_OPUS'
      : voiceNote.mime_type?.includes('wav') ? 'LINEAR16' : 'ENCODING_UNSPECIFIED';

    const result = await provider.transcribe(await object.arrayBuffer(), {
      encoding,
      durationSeconds: voiceNote.duration_seconds ?? 0,
    });

    if (!result.ok) {
      await scope.update('voice_notes', voiceNote.id, { transcript_status: 'failed' });
      return { ok: false, configured: true, error: result.error };
    }

    await scope.update('voice_notes', voiceNote.id, {
      transcript: result.data.text,
      transcript_status: 'done',
      transcript_lang: result.data.languageCode,
      transcript_confidence: result.data.confidence,
    });
    return { ok: true, configured: true, transcript: result.data.text };
  } catch (err) {
    await scope.update('voice_notes', voiceNote.id, { transcript_status: 'failed' });
    return { ok: false, configured: true, error: { message: err.message } };
  }
}

function num(v) {
  const n = Number(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { ClaudeProvider, VisionOcrProvider, SpeechProvider, monthKey };
