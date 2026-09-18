/**
 * The AI layer: OCR extraction, document pre-screening, the GST/TDS assistant
 * and the business insight feed (add-ons 1, 2, 12, 13, 14).
 *
 * One rule governs all of it. A model's output is a suggestion; the database
 * is the record. Extracted fields land in a review queue rather than on the
 * document, the assistant answers from figures this system computed, and an
 * insight always carries the numbers it was derived from.
 *
 * Where no model is configured, the deterministic half still runs — the
 * insight feed is arithmetic over stored data and needs no vendor at all.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import {
  BadRequestError, ConflictError, NotFoundError, IntegrationError,
} from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, monthKey } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { audit } from '../services/audit.js';
import { assertFeature, hasFeature } from '../services/features.js';
import { computeInsights, storeInsights } from '../services/insights.js';
import { getObject } from '../services/storage.js';
import { VisionOcrProvider, ClaudeProvider, OCR_PROFILES } from '../integrations/ai.js';

const OCR_PROFILE_KEYS = Object.keys(OCR_PROFILES);

const router = createRouter();

// ===========================================================================
// OCR
// ===========================================================================
router.get('/ocr', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('ocr_extractions', 'o');
  where.eqIf('o.status', ctx.q('status'));
  where.eqIf('o.review_status', ctx.q('reviewStatus'));
  where.eqIf('o.profile', ctx.q('profile'));
  if (ctx.qBool('needsReview')) where.add("o.review_status = 'pending' AND o.status = 'completed'");

  const { rows, total } = await scope.paginate('ocr_extractions', where, {
    columns: 'o.*, d.title AS document_title, c.display_name AS client_name',
    joins: `LEFT JOIN documents d ON d.id = o.document_id
            LEFT JOIN clients c ON c.id = d.client_id`,
    alias: 'o',
    orderBy: `o.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'overall_confidence'], 'created_at')}`,
    page, pageSize,
  });

  const counts = await scope.rawOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN review_status = 'pending' AND status = 'completed' THEN 1 ELSE 0 END) AS awaiting_review,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            AVG(overall_confidence) AS avg_confidence
       FROM ocr_extractions WHERE tenant_id = ?`, [ctx.tenantId]);

  return paginated(rows.map(toExtraction), {
    page, pageSize, total,
    summary: {
      total: Number(counts?.total) || 0,
      awaitingReview: Number(counts?.awaiting_review) || 0,
      failed: Number(counts?.failed) || 0,
      averageConfidence: counts?.avg_confidence
        ? Math.round(Number(counts.avg_confidence) * 100) / 100 : null,
    },
  }, ctx);
}, { permission: 'ai.ocr' });

router.post('/ocr/:documentId', async (ctx) => {
  await assertFeature(ctx, 'ocr_ai');
  const scope = scopeFor(ctx);
  const document = await scope.getOrFail('documents', ctx.params.documentId, { resource: 'Document' });

  const body = await ctx.body().catch(() => ({}));
  const input = validate(body ?? {}, {
    profile: { type: 'enum', values: OCR_PROFILE_KEYS, default: 'gst_invoice' },
    force: { type: 'boolean', default: false },
  });

  const existing = await scope.first('ocr_extractions', { document_id: document.id });
  if (existing && !input.force) {
    return ok({ extraction: toExtraction(existing), reused: true }, { ctx });
  }

  const provider = new VisionOcrProvider(ctx.env);
  if (!provider.isConfigured()) {
    throw new IntegrationError(provider.name,
      `OCR is not connected. Missing: ${provider.missingKeys().join(', ')}.`,
      { configured: false, details: { missingKeys: provider.missingKeys() } });
  }

  const version = await scope.first('document_versions', { id: document.current_version_id });
  if (!version?.storage_key) throw new ConflictError('That document has no stored file to read.');

  const object = await getObject(ctx.env, version.storage_key);
  if (!object) throw new ConflictError('The stored file could not be read.');

  const started = Date.now();
  const extractionId = existing?.id ?? ID.ocr();
  const record = {
    id: extractionId,
    document_id: document.id,
    version_id: version.id,
    profile: input.profile,
    provider: provider.key,
    status: 'running',
    review_status: 'pending',
    applied_to_records: 0,
  };
  if (existing) await scope.update('ocr_extractions', existing.id, record);
  else await scope.insert('ocr_extractions', record);

  const bytes = await new Response(object.body).arrayBuffer();
  const result = await provider.extract(bytes, input.profile);

  if (!result.ok) {
    await scope.update('ocr_extractions', extractionId, {
      status: 'failed',
      error_message: (result.error?.message ?? 'Extraction failed.').slice(0, 500),
      duration_ms: Date.now() - started,
    });
    throw new IntegrationError(provider.name,
      result.error?.message ?? 'The document could not be read.', { configured: true });
  }

  await scope.update('ocr_extractions', extractionId, {
    status: 'completed',
    overall_confidence: result.data.overallConfidence ?? null,
    fields_json: JSON.stringify(result.data.fields ?? {}),
    raw_text: (result.data.text ?? '').slice(0, 100000),
    // Pending review, always. Extracted numbers do not touch a tax record
    // until a person has looked at them.
    review_status: 'pending',
    duration_ms: Date.now() - started,
  });

  await scope.update('documents', document.id, { ocr_status: 'completed' });

  const fresh = await scope.first('ocr_extractions', { id: extractionId });
  return created({
    extraction: toExtraction(fresh),
    note: 'These values are suggestions from OCR. Nothing has been written to the document or to any tax record until you accept them.',
  }, { ctx });
}, { permission: 'ai.ocr' });

/** Accept, correct or reject what OCR read. */
router.post('/ocr/:id/review', async (ctx) => {
  const scope = scopeFor(ctx);
  const extraction = await scope.getOrFail('ocr_extractions', ctx.params.id, { resource: 'Extraction' });
  if (extraction.status !== 'completed') {
    throw new ConflictError(`That extraction is ${extraction.status}, so there is nothing to review.`);
  }

  const body = await ctx.body();
  const input = validate(body, {
    decision: { type: 'enum', required: true, values: ['accept', 'correct', 'reject'] },
    fields: { type: 'json' },
    note: { type: 'text', max: 1000 },
  });

  const original = safeJson(extraction.fields_json, {});
  const finalFields = input.decision === 'correct' ? { ...original, ...(input.fields ?? {}) } : original;

  await scope.update('ocr_extractions', extraction.id, {
    review_status: input.decision === 'reject' ? 'rejected' : 'approved',
    fields_json: JSON.stringify(finalFields),
    reviewed_by: ctx.userId,
    reviewed_at: nowIso(),
    applied_to_records: input.decision === 'reject' ? 0 : 1,
  });

  await audit(ctx, {
    action: 'documents.updated', category: 'documents',
    entityType: 'ocr_extraction', entityId: extraction.id,
    entityLabel: `OCR review (${input.decision})`,
    // Both sides recorded: what the model read, and what the human decided.
    oldValue: { fields: original, confidence: extraction.overall_confidence },
    newValue: { decision: input.decision, fields: finalFields, note: input.note ?? null },
  });

  return ok({
    extraction: toExtraction(await scope.first('ocr_extractions', { id: extraction.id })),
    corrections: input.decision === 'correct'
      ? Object.keys(input.fields ?? {}).filter(k => original[k] !== input.fields[k])
      : [],
  }, { ctx });
}, { permission: 'ai.ocr' });

// ===========================================================================
// Document pre-screening
// ===========================================================================
router.get('/verifications', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('ai_verifications', 'v');
  where.eqIf('v.status', ctx.q('status'));
  where.eqIf('v.recommendation', ctx.q('recommendation'));
  if (ctx.qBool('flaggedOnly')) where.add('v.flag_count > 0');

  const { rows, total } = await scope.paginate('ai_verifications', where, {
    columns: 'v.*, d.title AS document_title, c.display_name AS client_name',
    joins: `LEFT JOIN documents d ON d.id = v.document_id
            LEFT JOIN clients c ON c.id = d.client_id`,
    alias: 'v',
    orderBy: 'v.created_at DESC',
    page, pageSize,
  });

  return paginated(rows.map(v => ({
    id: v.id,
    documentId: v.document_id,
    documentTitle: v.document_title,
    clientName: v.client_name,
    status: v.status,
    confidence: v.confidence,
    checks: safeJson(v.checks_json, []),
    flags: safeJson(v.flags_json, []),
    flagCount: v.flag_count,
    // A recommendation, never a decision. A human still approves or rejects.
    recommendation: v.recommendation,
    provider: v.provider,
    error: v.error_message,
    createdAt: v.created_at,
  })), {
    page, pageSize, total,
    note: 'These are pre-screening results. A document is only verified when a person verifies it.',
  }, ctx);
}, { permission: 'ai.verify' });

// ===========================================================================
// Tax assistant
// ===========================================================================
router.get('/conversations', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('ai_conversations', { user_id: ctx.userId }, { limit: 50 });
  return ok({
    conversations: rows.map(c => ({
      id: c.id, kind: c.kind, title: c.title,
      messageCount: c.message_count, updatedAt: c.updated_at,
    })),
  }, { ctx });
}, { permission: 'ai.assistant' });

router.get('/conversations/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const conversation = await scope.getOrFail('ai_conversations', ctx.params.id, { resource: 'Conversation' });
  if (conversation.user_id !== ctx.userId) throw new NotFoundError('Conversation');

  const messages = await scope.raw(
    'SELECT * FROM ai_messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at ASC LIMIT 200',
    [ctx.tenantId, conversation.id]);

  return ok({
    conversation: { id: conversation.id, kind: conversation.kind, title: conversation.title },
    messages: messages.map(toAiMessage),
  }, { ctx });
}, { permission: 'ai.assistant' });

router.post('/ask', async (ctx) => {
  await assertFeature(ctx, 'ai_tax_assistant');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    question: { type: 'text', required: true, max: 2000 },
    conversationId: { type: 'id' },
    clientId: { type: 'id' },
    periodKey: { type: 'string', max: 10 },
  });

  const provider = new ClaudeProvider(ctx.env);
  if (!provider.isConfigured()) {
    throw new IntegrationError(provider.name,
      `The assistant is not connected. Missing: ${provider.missingKeys().join(', ')}.`,
      { configured: false, details: { missingKeys: provider.missingKeys() } });
  }

  let conversation = input.conversationId
    ? await scope.first('ai_conversations', { id: input.conversationId, user_id: ctx.userId })
    : null;
  if (!conversation) {
    conversation = await scope.insert('ai_conversations', {
      id: ID.conversation(),
      user_id: ctx.userId,
      kind: 'tax_assistant',
      title: input.question.slice(0, 80),
      context_json: JSON.stringify({ clientId: input.clientId ?? null, periodKey: input.periodKey ?? null }),
      message_count: 0,
    });
  }

  await scope.insert('ai_messages', {
    id: ID.aiMessage(),
    conversation_id: conversation.id,
    role: 'user',
    content: input.question,
  });

  // The grounding data: figures this system computed, not anything the model
  // recalls. An answer that cannot be traced to these is not worth giving.
  const grounding = await buildGrounding(scope, ctx, input);
  const history = await scope.raw(
    'SELECT role, content FROM ai_messages WHERE tenant_id = ? AND conversation_id = ? ORDER BY created_at ASC LIMIT 20',
    [ctx.tenantId, conversation.id]);

  const started = Date.now();
  const result = await provider.complete({
    system: buildSystemPrompt(grounding),
    messages: [
      ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    ],
    maxTokens: 1200,
  });

  if (!result.ok) {
    await scope.insert('ai_messages', {
      id: ID.aiMessage(),
      conversation_id: conversation.id,
      role: 'assistant',
      content: '',
      error_message: (result.error?.message ?? 'The assistant could not answer.').slice(0, 500),
      latency_ms: Date.now() - started,
    });
    throw new IntegrationError(provider.name,
      result.error?.message ?? 'The assistant could not answer.', { configured: true });
  }

  const message = await scope.insert('ai_messages', {
    id: ID.aiMessage(),
    conversation_id: conversation.id,
    role: 'assistant',
    content: result.data.text,
    citations_json: JSON.stringify(grounding.citations ?? []),
    // Flags that the answer was grounded in stored figures rather than the
    // model's own recollection of Indian tax law.
    is_verified_data: grounding.citations?.length ? 1 : 0,
    disclaimer: 'This is guidance based on your recorded figures, not professional tax advice. Check it before filing.',
    model: result.data.model ?? null,
    tokens_in: result.data.tokensIn ?? null,
    tokens_out: result.data.tokensOut ?? null,
    latency_ms: Date.now() - started,
  });

  await scope.update('ai_conversations', conversation.id, {
    message_count: (conversation.message_count ?? 0) + 2,
  });

  return created({
    conversationId: conversation.id,
    message: toAiMessage(message),
    grounding: {
      citations: grounding.citations ?? [],
      // Said plainly when the question could not be tied to stored figures.
      groundedInYourData: !!grounding.citations?.length,
      note: grounding.citations?.length
        ? 'This answer refers to figures computed from your own records.'
        : 'No matching figures were found in your records, so this answer is general guidance only.',
    },
  }, { ctx });
}, { permission: 'ai.assistant' });

// ===========================================================================
// Business insights
// ===========================================================================
router.get('/insights', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('ai_insights', {}, { limit: 60 });

  return ok({
    insights: rows.map(i => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      body: i.body,
      severity: i.severity,
      entityType: i.entity_type,
      entityId: i.entity_id,
      // The numbers behind the claim, so a reader can check it rather than
      // take it on faith.
      metrics: safeJson(i.metrics_json, null),
      confidence: i.confidence,
      periodKey: i.period_key,
      generatedBy: i.generated_by,
      acknowledged: !!i.acknowledged_at,
      acknowledgedAt: i.acknowledged_at,
      dismissedAt: i.dismissed_at,
      createdAt: i.created_at,
    })),
  }, { ctx });
}, { permission: 'ai.insights' });

/** Recompute the feed now. The analysis is arithmetic and needs no vendor. */
router.post('/insights/refresh', async (ctx) => {
  const scope = scopeFor(ctx);
  const insights = await computeInsights(scope);
  await storeInsights(scope, insights, { periodKey: monthKey() });

  const aiConfigured = new ClaudeProvider(ctx.env).isConfigured();
  return ok({
    generated: insights.length,
    periodKey: monthKey(),
    // The distinction matters: the findings are computed either way, and a
    // model only ever rewrites them into prose.
    source: 'computed',
    narrativeAvailable: aiConfigured,
    note: aiConfigured
      ? 'Findings are computed from your records. The weekly digest turns them into prose.'
      : 'Findings are computed from your records. No language model is configured, so the digest stays in this structured form.',
  }, { ctx });
}, { permission: 'ai.insights' });

router.post('/insights/:id/acknowledge', async (ctx) => {
  const scope = scopeFor(ctx);
  const insight = await scope.getOrFail('ai_insights', ctx.params.id, { resource: 'Insight' });
  const body = await ctx.body().catch(() => ({}));
  const input = validate(body ?? {}, { dismiss: { type: 'boolean', default: false } });

  await scope.update('ai_insights', insight.id, {
    acknowledged_by: ctx.userId,
    acknowledged_at: nowIso(),
    dismissed_at: input.dismiss ? nowIso() : null,
  });

  return ok({ id: insight.id, acknowledged: true, dismissed: input.dismiss }, { ctx });
}, { permission: 'ai.insights' });

/** What the AI layer can and cannot do right now, for the settings screen. */
router.get('/status', async (ctx) => {
  const vision = new VisionOcrProvider(ctx.env);
  const claude = new ClaudeProvider(ctx.env);

  return ok({
    capabilities: [
      {
        key: 'ocr',
        name: 'OCR document reading',
        provider: vision.name,
        configured: vision.isConfigured(),
        missingKeys: vision.missingKeys(),
        featureUnlocked: await hasFeature(ctx, 'ocr_ai'),
      },
      {
        key: 'assistant',
        name: 'GST & tax assistant',
        provider: claude.name,
        configured: claude.isConfigured(),
        missingKeys: claude.missingKeys(),
        featureUnlocked: await hasFeature(ctx, 'ai_tax_assistant'),
      },
      {
        key: 'insights',
        name: 'Business insights',
        provider: 'Computed from your records',
        // Deliberately true: the analysis is arithmetic, and works with no
        // vendor connected at all.
        configured: true,
        missingKeys: [],
        featureUnlocked: await hasFeature(ctx, 'ai_business_insights'),
        note: 'Findings are computed locally. A language model only rewrites them as prose.',
      },
    ],
  }, { ctx });
}, { anyPermission: ['ai.ocr', 'ai.assistant', 'ai.insights'] });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The system prompt.
 *
 * Written to constrain rather than to flatter: the model is told the figures
 * are the only authority, and told to say it does not know rather than supply
 * a plausible number. A tax figure invented by a language model and acted on
 * by an accountant is the failure this whole module is shaped to avoid.
 */
function buildSystemPrompt(grounding) {
  return [
    'You are a GST and TDS assistant inside an Indian accounting CRM.',
    '',
    'These figures were computed by the CRM from the organisation\'s own records.',
    'They are the only authority. Answer from them and nothing else.',
    '',
    JSON.stringify(grounding.data, null, 2),
    '',
    'Rules:',
    '- Never state a figure that is not in the data above.',
    '- If the data does not answer the question, say so plainly and say what',
    '  record would be needed.',
    '- Do not give a confident answer about a rate, threshold or due date you',
    '  are not certain of; say it should be checked against the current CBIC',
    '  notification.',
    '- Amounts above are already formatted in rupees. Quote them as given.',
    '- Be brief. An accountant is reading this between other work.',
  ].join('\n');
}

/**
 * Assemble the figures an answer may cite.
 *
 * Only computed records go in — GST and TDS totals this system produced, and
 * the client's filing status. Nothing is invented, and the citations list is
 * exactly what the model was shown.
 */
async function buildGrounding(scope, ctx, input) {
  const citations = [];
  const data = {};

  const periodKey = input.periodKey ?? monthKey();

  const computations = await scope.raw(
    `SELECT tc.*, c.display_name AS client_name FROM tax_computations tc
       LEFT JOIN clients c ON c.id = tc.client_id
      WHERE tc.tenant_id = ? AND tc.period_key = ?
        ${input.clientId ? 'AND tc.client_id = ?' : ''}
      ORDER BY tc.created_at DESC LIMIT 10`,
    input.clientId ? [ctx.tenantId, periodKey, input.clientId] : [ctx.tenantId, periodKey]);

  if (computations.length) {
    data.computations = computations.map(c => ({
      client: c.client_name,
      periodKey: c.period_key,
      status: c.status,
      taxableValue: formatINR(c.taxable_value_paise ?? 0),
      totalTax: formatINR(c.total_tax_paise ?? 0),
      itc: formatINR(c.itc_total_paise ?? 0),
      netPayable: formatINR(c.net_payable_paise ?? 0),
    }));
    citations.push(...computations.map(c => ({
      type: 'tax_computation', id: c.id,
      label: `${c.client_name ?? 'Computation'} — ${c.period_key}`,
    })));
  }

  const periods = await scope.raw(
    `SELECT fp.period_key, fp.status, fp.due_date, fp.documents_expected, fp.documents_verified,
            c.display_name AS client_name
       FROM filing_periods fp LEFT JOIN clients c ON c.id = fp.client_id
      WHERE fp.tenant_id = ? ${input.clientId ? 'AND fp.client_id = ?' : ''}
        AND fp.status != 'filed'
      ORDER BY fp.due_date LIMIT 10`,
    input.clientId ? [ctx.tenantId, input.clientId] : [ctx.tenantId]);

  if (periods.length) {
    data.openPeriods = periods.map(p => ({
      client: p.client_name, periodKey: p.period_key, status: p.status,
      dueDate: p.due_date, documentsVerified: p.documents_verified, documentsExpected: p.documents_expected,
    }));
  }

  return { data, citations, periodKey };
}

function toExtraction(o) {
  return {
    id: o.id,
    documentId: o.document_id,
    documentTitle: o.document_title ?? null,
    clientName: o.client_name ?? null,
    profile: o.profile,
    provider: o.provider,
    status: o.status,
    confidence: o.overall_confidence,
    fields: safeJson(o.fields_json, {}),
    reviewStatus: o.review_status,
    reviewedBy: o.reviewed_by,
    reviewedAt: o.reviewed_at,
    appliedToRecords: !!o.applied_to_records,
    error: o.error_message,
    durationMs: o.duration_ms,
    createdAt: o.created_at,
  };
}

function toAiMessage(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    citations: safeJson(m.citations_json, []),
    groundedInYourData: !!m.is_verified_data,
    disclaimer: m.disclaimer,
    model: m.model,
    error: m.error_message,
    latencyMs: m.latency_ms,
    createdAt: m.created_at,
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as aiRouter };
