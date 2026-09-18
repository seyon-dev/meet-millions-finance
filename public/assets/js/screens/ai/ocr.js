/**
 * OCR review.
 *
 * What the machine read out of each document, and a person's decision about
 * it. Nothing extracted is written into the tax records until somebody accepts
 * it — the confidence figure is shown per field, because a 62% reading of a
 * GSTIN is not the same as a 99% one and should not look the same.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, modal, banner, lockedState,
} from '../../core/ui.js';
import { dataTable, selectFilter } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function ocrScreen() {
  setBreadcrumbs([{ label: 'OCR review' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const noticeHost = el('div');

  let status;
  try {
    ({ data: status } = await api.get('/ai/status'));
  } catch (err) {
    if (err.name === 'FeatureLocked') {
      render(page,
        pageHead({ title: 'OCR review' }),
        lockedState({
          featureName: 'OCR document reading',
          requiredAddOn: 'ai_ocr_engine',
          message: 'Reads invoices, bank statements and PAN cards, and fills the tax records from them.',
        }));
      return page;
    }
    render(page, errorState(err));
    return page;
  }

  const capability = (status.capabilities ?? []).find(c => c.key === 'ocr');
  if (capability && !capability.configured) {
    render(noticeHost, banner({
      text: `${capability.provider} is not connected${capability.missingKeys?.length ? ` — ${capability.missingKeys.join(', ')} not set` : ''}, so no new document can be read. Anything below was read earlier.`,
      tone: 'warning',
      icon: 'plug',
      action: session.can('integrations.manage')
        ? { label: 'Open integrations', href: '/settings/integrations' }
        : null,
    }));
  }

  const table = dataTable({
    searchPlaceholder: 'Search by document or client…',
    defaultSort: 'created_at',
    onRowClick: (row) => openExtraction(row, table),
    filters: (apply, active) => [
      selectFilter({
        label: 'Review',
        options: ['pending', 'accepted', 'edited', 'rejected'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.reviewStatus ?? '',
        onChange: v => apply('reviewStatus', v),
      }),
      selectFilter({
        label: 'Outcome',
        options: ['done', 'failed', 'processing', 'queued'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
    ],
    load: async (params) => {
      const { data, meta } = await api.get('/ai/ocr', params);
      paintTiles(meta.summary);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'documentTitle',
        label: 'Document',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.documentTitle ?? row.documentId }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.clientName, fmt.label(row.profile)].filter(Boolean).join(' · '),
          })),
      },
      {
        key: 'confidence',
        label: 'Confidence',
        align: 'right',
        render: row => (row.confidence === null || row.confidence === undefined
          ? el('span.mm-muted', { text: '—' })
          : el('span.mm-numeric', {
              class: row.confidence >= 0.9 ? 'mm-c-success' : row.confidence >= 0.7 ? 'mm-c-warning' : 'mm-c-danger',
              text: `${Math.round(row.confidence * 100)}%`,
            })),
      },
      {
        key: 'fieldCount',
        label: 'Fields',
        align: 'center',
        hideOnMobile: true,
        render: row => el('span.mm-numeric', { text: String(fieldList(row.fields).length) }),
      },
      { key: 'status', label: 'Read', render: row => statusPill(row.status) },
      {
        key: 'reviewStatus',
        label: 'Review',
        render: row => (row.reviewStatus === 'pending'
          ? pill('Needs review', 'warning')
          : statusPill(row.reviewStatus)),
      },
      { key: 'createdAt', label: 'Read at', format: 'relative' },
    ],
    empty: {
      title: 'Nothing has been read yet',
      message: 'Documents are read when OCR is run on them from the verification workspace.',
      icon: 'scan-text',
    },
  });

  function paintTiles(summary) {
    if (!summary) return;
    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Read', value: fmt.number(summary.total ?? 0), icon: 'scan-text' }),
      stat({
        label: 'Awaiting review',
        value: fmt.number(summary.awaitingReview ?? 0),
        icon: 'eye',
        tone: (summary.awaitingReview ?? 0) > 0 ? 'warning' : null,
      }),
      stat({
        label: 'Failed',
        value: fmt.number(summary.failed ?? 0),
        icon: 'x-circle',
        tone: (summary.failed ?? 0) > 0 ? 'danger' : null,
      }),
      stat({
        label: 'Average confidence',
        value: summary.averageConfidence ? `${Math.round(summary.averageConfidence * 100)}%` : '—',
        icon: 'sparkle',
      })));
  }

  page.append(
    pageHead({
      title: 'OCR review',
      subtitle: 'What was read out of each document, and whether a person has accepted it.',
    }),
    noticeHost,
    tileHost,
    card({ body: table.node, flush: true }));

  return page;
}

/** Fields come back as an object or an array depending on the profile. */
function fieldList(fields) {
  if (!fields) return [];
  if (Array.isArray(fields)) return fields;
  return Object.entries(fields).map(([key, value]) =>
    (value && typeof value === 'object' && 'value' in value
      ? { key, ...value }
      : { key, value }));
}

/**
 * Review one extraction.
 *
 * Every field is editable, because correcting a misread digit here is the
 * whole point; accepting without looking is possible but is a separate button
 * from correcting, so the audit trail records which happened.
 */
async function openExtraction(extraction, table) {
  const fields = fieldList(extraction.fields);
  const canReview = session.can('ai.ocr');

  const result = await modal({
    title: extraction.documentTitle ?? 'Extraction',
    description: [extraction.clientName, fmt.label(extraction.profile), extraction.provider]
      .filter(Boolean).join(' · '),
    size: 'lg',
    body: ({ close }) => {
      const edited = {};
      const inputs = fields.map((field) => {
        const input = el('input.mm-input', {
          value: field.value ?? '',
          disabled: !canReview,
          onInput: (e) => { edited[field.key] = e.target.value; },
        });

        return el('div.mm-field',
          el('label.mm-field__label',
            el('span', { text: fmt.label(field.label ?? field.key) }),
            field.confidence !== undefined && field.confidence !== null
              ? el('span.mm-field__conf', {
                  class: field.confidence >= 0.9 ? 'mm-c-success' : field.confidence >= 0.7 ? 'mm-c-warning' : 'mm-c-danger',
                  text: `${Math.round(field.confidence * 100)}%`,
                })
              : null),
          input);
      });

      return frag(
        extraction.status === 'failed'
          ? banner({ text: extraction.error ?? 'This document could not be read.', tone: 'danger', icon: 'x-circle' })
          : null,

        extraction.appliedToRecords
          ? banner({
              text: 'These values have already been written into the tax records.',
              tone: 'info',
              icon: 'check-circle',
            })
          : null,

        fields.length
          ? el('div.mm-grid.mm-grid-2.mm-gap-3', ...inputs)
          : el('p.mm-muted.mm-text-sm', { text: 'Nothing was extracted from this document.' }),

        el('div.mm-row.mm-gap-2.mm-mt-5',
          el('a.mm-btn.mm-btn--ghost', {
            href: `/documents/${extraction.documentId}`,
            text: 'Open the document',
          }),
          el('span.mm-grow'),
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) }),
          canReview && extraction.reviewStatus === 'pending'
            ? frag(
                el('button.mm-btn.mm-btn--ghost.mm-btn--danger-text', {
                  type: 'button', text: 'Reject', onClick: () => close({ decision: 'reject' }),
                }),
                el('button.mm-btn.mm-btn--outline', {
                  type: 'button',
                  text: 'Save corrections',
                  onClick: () => close({ decision: 'correct', fields: edited }),
                }),
                el('button.mm-btn.mm-btn--primary', {
                  type: 'button', text: 'Accept as read', onClick: () => close({ decision: 'accept' }),
                }))
            : null));
    },
  });

  if (!result) return;

  try {
    await api.post(`/ai/ocr/${extraction.id}/review`, {
      decision: result.decision,
      fields: result.fields && Object.keys(result.fields).length ? result.fields : undefined,
    });
    notify.success({
      accept: 'Accepted.',
      correct: 'Corrections saved.',
      reject: 'Rejected. Nothing was written to the records.',
    }[result.decision]);
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
