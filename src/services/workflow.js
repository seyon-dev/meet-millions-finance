/**
 * The filing workflow.
 *
 * The proposal defines ten stages from registration to archive. This module
 * owns the rules for moving between them: which document status transitions
 * are legal, how a filing period's status is derived from its documents and
 * queries, and what each stage means for the stepper the UI renders.
 *
 * Status is *derived* wherever possible rather than set by hand, so the number
 * on a client's dashboard cannot drift from the documents underneath it.
 */

import { WORKFLOW_STAGES, FILING_STATUSES } from '../data/document-types.js';
import { BadRequestError } from '../http/errors.js';
import { nowIso, addHours } from '../utils/time.js';

/** Legal document status transitions. Anything not listed is refused. */
export const DOCUMENT_TRANSITIONS = {
  draft:           ['submitted', 'archived'],
  submitted:       ['under_review', 'query_raised', 'verified', 'rejected', 'archived'],
  under_review:    ['verified', 'rejected', 'query_raised', 'submitted'],
  query_raised:    ['awaiting_client', 'under_review', 'verified', 'rejected'],
  awaiting_client: ['submitted', 'under_review', 'query_raised', 'rejected'],
  verified:        ['approved', 'under_review', 'archived'],   // reopening is allowed, and audited
  approved:        ['archived', 'under_review'],
  rejected:        ['submitted', 'under_review', 'archived'],
  archived:        [],
};

export function canTransitionDocument(from, to) {
  if (from === to) return true;
  return (DOCUMENT_TRANSITIONS[from] ?? []).includes(to);
}

export function assertDocumentTransition(from, to) {
  if (!canTransitionDocument(from, to)) {
    throw new BadRequestError(
      `A document that is "${label(from)}" cannot move straight to "${label(to)}".`,
      { from, to, allowed: DOCUMENT_TRANSITIONS[from] ?? [] });
  }
}

/** Legal filing-period transitions. */
export const PERIOD_TRANSITIONS = {
  collecting:       ['under_review', 'query_raised', 'verified', 'rejected'],
  under_review:     ['query_raised', 'awaiting_client', 'verified', 'collecting', 'rejected'],
  query_raised:     ['awaiting_client', 'under_review', 'verified'],
  awaiting_client:  ['under_review', 'query_raised', 'verified'],
  verified:         ['calculated', 'under_review'],
  calculated:       ['pending_approval', 'verified'],
  pending_approval: ['approved', 'rejected', 'calculated'],
  approved:         ['client_review', 'pending_approval'],
  client_review:    ['signed_off', 'approved', 'rejected'],
  signed_off:       ['paid', 'filed'],
  paid:             ['filed'],
  filed:            ['archived'],
  archived:         [],
  rejected:         ['under_review', 'collecting'],
};

export function canTransitionPeriod(from, to) {
  if (from === to) return true;
  return (PERIOD_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Recompute a filing period's status and counters from the documents, queries
 * and computations beneath it. Called after every state-changing action.
 *
 * Stages past "verified" (calculated, approved, signed off, paid, filed) are
 * driven by explicit decisions, so this never drags a period backwards out of
 * them — it only refreshes the counters.
 */
export async function refreshFilingPeriod(scope, filingPeriodId) {
  const period = await scope.first('filing_periods', { id: filingPeriodId });
  if (!period) return null;

  const counts = await scope.rawOne(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('submitted','under_review','query_raised','awaiting_client','verified','approved','archived') THEN 1 ELSE 0 END) AS received,
        SUM(CASE WHEN status IN ('verified','approved','archived') THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN status = 'under_review' THEN 1 ELSE 0 END) AS under_review,
        SUM(CASE WHEN status = 'query_raised' THEN 1 ELSE 0 END) AS queried,
        SUM(CASE WHEN status = 'awaiting_client' THEN 1 ELSE 0 END) AS awaiting,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted
       FROM documents
      WHERE tenant_id = ? AND filing_period_id = ? AND deleted_at IS NULL`,
    [scope.tenantId, filingPeriodId]);

  const expected = await scope.rawOne(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN status IN ('verified') THEN 1 ELSE 0 END) AS done
       FROM checklist_items WHERE tenant_id = ? AND filing_period_id = ? AND is_required = 1`,
    [scope.tenantId, filingPeriodId]);

  const openQueries = await scope.rawCount(
    `SELECT COUNT(*) FROM queries
      WHERE tenant_id = ? AND filing_period_id = ?
        AND status IN ('open','awaiting_client','client_responded','under_review')`,
    [scope.tenantId, filingPeriodId]);

  const total = Number(counts?.total) || 0;
  const received = Number(counts?.received) || 0;
  const verified = Number(counts?.verified) || 0;
  const expectedCount = Number(expected?.n) || period.documents_expected || 0;

  const terminal = ['calculated', 'pending_approval', 'approved', 'client_review', 'signed_off', 'paid', 'filed', 'archived'];
  let status = period.status;

  if (!terminal.includes(period.status)) {
    if (Number(counts?.queried) > 0) status = 'query_raised';
    else if (Number(counts?.awaiting) > 0 || openQueries > 0) status = 'awaiting_client';
    else if (expectedCount > 0 && verified >= expectedCount && total > 0) status = 'verified';
    else if (total > 0 && verified === total) status = 'verified';
    else if (Number(counts?.under_review) > 0) status = 'under_review';
    else if (received > 0) status = 'under_review';
    else status = 'collecting';
  }

  const patch = {
    documents_expected: expectedCount,
    documents_received: received,
    documents_verified: verified,
    status,
    updated_at: nowIso(),
  };
  await scope.update('filing_periods', filingPeriodId, patch);

  return {
    ...period,
    ...patch,
    openQueries,
    rejected: Number(counts?.rejected) || 0,
    submitted: Number(counts?.submitted) || 0,
  };
}

/** Keep the checklist row in step with the document that satisfies it. */
export async function syncChecklistForDocument(scope, document) {
  if (!document.filing_period_id) return null;

  const item = await scope.rawOne(
    `SELECT * FROM checklist_items
      WHERE tenant_id = ? AND filing_period_id = ? AND document_type_id = ?
      ORDER BY (document_id = ?) DESC LIMIT 1`,
    [scope.tenantId, document.filing_period_id, document.document_type_id, document.id]);
  if (!item) return null;

  const statusMap = {
    draft: 'pending',
    submitted: 'submitted',
    under_review: 'under_review',
    query_raised: 'query_raised',
    awaiting_client: 'query_raised',
    verified: 'verified',
    approved: 'verified',
    rejected: 'rejected',
    archived: 'verified',
  };

  await scope.update('checklist_items', item.id, {
    document_id: document.id,
    status: statusMap[document.status] ?? 'submitted',
  });
  return item;
}

/**
 * The stepper the client dashboard and filing detail screen render.
 * Returns each of the ten stages with its state: done | current | blocked | todo.
 */
export function buildStageProgress(period, { openQueries = 0, hasReport = false, hasPayment = false } = {}) {
  const status = period?.status ?? 'collecting';

  const reached = {
    registration: true,
    upload: (period?.documents_received ?? 0) > 0 || statusAtLeast(status, 'under_review'),
    verification: statusAtLeast(status, 'under_review'),
    query: openQueries > 0 || ['query_raised', 'awaiting_client'].includes(status),
    verified: statusAtLeast(status, 'verified'),
    calculation: statusAtLeast(status, 'calculated'),
    approval: statusAtLeast(status, 'approved'),
    client_review: statusAtLeast(status, 'client_review') || hasReport,
    payment: statusAtLeast(status, 'paid') || hasPayment,
    archive: status === 'archived',
  };

  const currentKey = currentStageKey(status, openQueries);

  return WORKFLOW_STAGES.map(stage => {
    let state = 'todo';
    if (stage.key === 'query') {
      state = openQueries > 0 ? 'blocked' : (reached.verified ? 'done' : 'todo');
    } else if (reached[stage.key]) {
      state = 'done';
    }
    if (stage.key === currentKey && state !== 'blocked') state = 'current';
    return { ...stage, state };
  });
}

function statusAtLeast(status, target) {
  const order = ['collecting', 'under_review', 'query_raised', 'awaiting_client', 'verified',
    'calculated', 'pending_approval', 'approved', 'client_review', 'signed_off', 'paid', 'filed', 'archived'];
  const a = order.indexOf(status);
  const b = order.indexOf(target);
  if (a === -1 || b === -1) return false;
  // query_raised / awaiting_client sit at the same depth as under_review.
  const normalise = (i) => (i === 2 || i === 3 ? 1 : i);
  return normalise(a) >= normalise(b);
}

function currentStageKey(status, openQueries) {
  if (openQueries > 0) return 'query';
  const map = {
    collecting: 'upload',
    under_review: 'verification',
    query_raised: 'query',
    awaiting_client: 'query',
    verified: 'calculation',
    calculated: 'approval',
    pending_approval: 'approval',
    approved: 'client_review',
    client_review: 'client_review',
    signed_off: 'payment',
    paid: 'archive',
    filed: 'archive',
    archived: 'archive',
    rejected: 'verification',
  };
  return map[status] ?? 'upload';
}

/** SLA deadline for a newly submitted document. */
export function slaDueAt(slaHours = 48, from = new Date()) {
  return addHours(slaHours, from);
}

export function statusMeta(status) {
  return FILING_STATUSES.find(s => s.key === status) ?? { key: status, label: label(status), tone: 'neutral', step: 0 };
}

function label(status) {
  return String(status ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

export { WORKFLOW_STAGES, FILING_STATUSES };
