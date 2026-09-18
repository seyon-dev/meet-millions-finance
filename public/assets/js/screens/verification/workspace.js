/**
 * The verification workspace.
 *
 * One document, one decision, as few clicks as the decision honestly allows.
 * The file fills the left; the right is a single column that reads top to
 * bottom: what this is, what the machine noticed, what the checklist asks,
 * and the four things you can do about it.
 *
 * Time on the document is measured, not estimated — the clock starts when the
 * screen opens and is sent with the decision, because SLA reporting built on
 * guessed durations is reporting nobody trusts.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, iconButton, statusPill, pill, avatar, emptyState, errorState,
  notify, notifyError, banner, skeletonTable, modal,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

/** The reviewer's checklist. Ticking is optional; recording it is not. */
const CHECKS = [
  { key: 'legible', label: 'The document is legible and complete' },
  { key: 'period', label: 'It belongs to the filing period claimed' },
  { key: 'identity', label: 'GSTIN / PAN match the client on file' },
  { key: 'arithmetic', label: 'Totals and tax add up' },
  { key: 'duplicate', label: 'Not a duplicate of something already filed' },
];

export default async function verificationWorkspaceScreen({ params }) {
  const page = el('div.mm-page.mm-page--wide');
  render(page, skeletonTable(8, 3));

  const openedAt = Date.now();

  async function load() {
    try {
      const { data } = await api.get(`/verification/${params.id}`);
      setBreadcrumbs([
        { label: 'Verification', href: '/verification' },
        { label: data.client?.display_name ?? 'Document', href: `/verification?clientId=${data.document.clientId}` },
        { label: data.document.title },
      ]);
      render(page, ...build(data, { reload: load, openedAt }));

      // Marking it under review is a side effect of opening it, not a button:
      // a queue where two people silently review the same document is a queue
      // that wastes half its capacity.
      if (data.document.status === 'submitted' && session.can('documents.verify')) {
        api.post(`/verification/${params.id}/open`, {}).catch(() => {
          // Losing the claim is not worth interrupting the review for; the
          // decision itself will fail loudly if somebody else got there first.
        });
      }
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, { reload, openedAt }) {
  const { document: doc, client, type, version, history, comments, queries, aiCheck, ocr, navigation, features } = data;
  const canDecide = session.can('documents.verify') && !doc.isLocked
    && !['verified', 'approved', 'archived'].includes(doc.status);

  return [
    pageHead({
      title: doc.title,
      subtitle: [client?.display_name, type?.name, fmt.label(doc.periodKey)].filter(Boolean).join(' · '),
      actions: frag(
        navigator_(navigation),
        button('Open full record', { variant: 'ghost', icon: 'external', href: `/documents/${doc.id}` })),
    }),

    doc.isLocked
      ? banner({ text: 'This document is locked; no new decision can be recorded until it is unlocked.', tone: 'info', icon: 'lock' })
      : null,

    doc.slaDueAt && new Date(doc.slaDueAt) < new Date() && canDecide
      ? banner({
          text: `Past its SLA — it was due ${fmt.dateTime(doc.slaDueAt)}.`,
          tone: 'danger',
          icon: 'alert',
        })
      : null,

    el('div.mm-workspace',
      el('div.mm-workspace__doc', previewPanel(doc, version)),
      el('div.mm-workspace__side',
        factsCard(doc, client, type, version),
        ocr || aiCheck ? machineCard({ ocr, aiCheck, features }) : null,
        canDecide
          ? decisionCard(doc, { reload, openedAt })
          : settledCard(doc),
        historyCard(history ?? []),
        queries?.length ? queriesCard(queries) : null,
        commentsCard(doc, comments ?? [], reload))),
  ].filter(Boolean);
}

/** Previous / next within the same filing period. */
function navigator_(navigation) {
  if (!navigation || !navigation.total) return null;
  return el('div.mm-row.mm-gap-1.mm-center',
    iconButton('chevron-left', {
      label: 'Previous document in this period',
      href: navigation.previousId ? `/verification/${navigation.previousId}` : null,
      onClick: navigation.previousId ? null : () => notify.info('This is the first document in the period.'),
    }),
    el('span.mm-muted.mm-text-xs.mm-nowrap', {
      text: `${navigation.index ?? '—'} of ${navigation.total}`,
    }),
    iconButton('chevron-right', {
      label: 'Next document in this period',
      href: navigation.nextId ? `/verification/${navigation.nextId}` : null,
      onClick: navigation.nextId ? null : () => notify.info('This is the last document in the period.'),
    }));
}

/**
 * The file.
 *
 * Fetched as an authorised blob rather than pointed at by src: the file route
 * needs the session header, which a browser will not attach to an iframe's
 * own request.
 */
function previewPanel(doc, version) {
  const host = el('div.mm-preview.mm-preview--tall');

  if (!version) {
    render(host, emptyState({ title: 'No file to review', icon: 'file', inline: true }));
  } else {
    render(host, el('div.mm-preview__loading', el('span.mm-spinner'), el('span', { text: 'Opening the file…' })));

    api.raw(`/documents/${doc.id}/download`)
      .then(response => response.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (version.mime_type?.startsWith('image/')) {
          render(host, el('img.mm-preview__img', { src: url, alt: version.file_name }));
        } else if (version.mime_type === 'application/pdf') {
          render(host, el('iframe.mm-preview__frame', { src: url, title: version.file_name }));
        } else {
          URL.revokeObjectURL(url);
          render(host, emptyState({
            title: version.file_name,
            message: 'This file type cannot be shown in the browser. Download it to review it.',
            icon: 'file',
            inline: true,
            action: {
              label: 'Download',
              onClick: () => api.download(`/documents/${doc.id}/download`, { fileName: version.file_name })
                .catch(notifyError),
            },
          }));
        }
      })
      .catch(err => render(host, errorState(err)));
  }

  return card({
    title: version?.file_name ?? 'File',
    subtitle: version
      ? `Version ${version.version_no} · ${fmt.bytes(version.size_bytes)} · uploaded ${fmt.relative(version.created_at)}`
      : null,
    actions: version
      ? iconButton('download', {
          label: 'Download this file',
          onClick: () => api.download(`/documents/${doc.id}/download`, { fileName: version.file_name })
            .catch(notifyError),
        })
      : null,
    body: host,
    flush: true,
    className: 'mm-card--fill',
  });
}

function factsCard(doc, client, type, version) {
  return card({
    title: 'What this is',
    actions: statusPill(doc.status),
    body: el('div.mm-kvgrid',
      kv('Client', client?.display_name),
      kv('GSTIN', client?.gstin, { mono: true }),
      kv('Type', type?.name),
      kv('Period', fmt.label(doc.periodKey)),
      kv('Uploaded', fmt.dateTime(doc.createdAt)),
      kv('Source', fmt.label(doc.source)),
      kv('SLA due', doc.slaDueAt ? fmt.dateTime(doc.slaDueAt) : null),
      kv('Version', version ? `v${version.version_no} of ${doc.versionCount}` : null)),
  });
}

/**
 * What the machine noticed.
 *
 * Shown as assistance, never as a verdict: the heading says advisory, the
 * confidence is printed, and nothing here changes the document's status.
 */
function machineCard({ ocr, aiCheck, features }) {
  return card({
    title: 'Machine reading',
    subtitle: 'Advisory. A person still decides.',
    className: 'mm-card--ai',
    body: frag(
      aiCheck
        ? frag(
            el('div.mm-row.mm-gap-2.mm-center.mm-mb-3',
              icon('sparkle', { size: 'sm' }),
              pill(aiCheck.verdict ?? aiCheck.status,
                aiCheck.verdict === 'pass' ? 'success' : aiCheck.verdict === 'fail' ? 'danger' : 'warning'),
              aiCheck.confidence
                ? el('span.mm-muted.mm-text-xs', { text: `${Math.round(aiCheck.confidence * 100)}% confidence` })
                : null),
            (aiCheck.checks ?? []).length
              ? el('ul.mm-checklist',
                  ...aiCheck.checks.map(check => el('li.mm-checklist__item',
                    el('span.mm-checklist__icon', { class: check.passed ? 'mm-c-success' : 'mm-c-warning' },
                      icon(check.passed ? 'check' : 'alert', { size: 'sm' })),
                    el('span', { text: check.label ?? check.key }))))
              : null,
            (aiCheck.flags ?? []).length
              ? el('ul.mm-flags.mm-mt-2',
                  ...aiCheck.flags.map(flag => el('li.mm-flags__item',
                    icon('alert', { size: 'sm' }),
                    el('span', { text: flag.message ?? String(flag) }))))
              : null)
        : (features?.aiVerification
            ? el('p.mm-muted.mm-text-sm', { text: 'No automated check has run on this document.' })
            : null),

      ocr
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: `Extracted fields — ${fmt.label(ocr.status)}` }),
            (ocr.fields ?? []).length
              ? el('div.mm-kvgrid',
                  ...ocr.fields.map(field => kv(fmt.label(field.key ?? field.label), field.value ?? '—')))
              : el('p.mm-muted.mm-text-sm', {
                  text: ocr.status === 'failed' ? (ocr.error ?? 'The file could not be read.') : 'Nothing was extracted.',
                }))
        : null),
  });
}

/**
 * The decision.
 *
 * Four outcomes, each with the consequence written beside it. The checklist is
 * sent with the decision so a later reviewer can see what was actually looked
 * at, not merely that somebody clicked approve.
 */
function decisionCard(doc, { reload, openedAt }) {
  const ticked = new Set();
  const notes = el('textarea.mm-input.mm-textarea', {
    rows: '3',
    placeholder: 'Notes for the record (required when rejecting)',
    'aria-label': 'Decision notes',
  });

  const busy = (on) => {
    for (const node of card_.querySelectorAll('button')) node.disabled = on;
  };

  async function decide(decision, extra = {}) {
    const text = notes.value.trim();
    if (decision === 'reject' && !text) {
      notify.warning('Tell the client why it was rejected — the reason goes to them.');
      notes.focus();
      return;
    }

    busy(true);
    try {
      await api.post(`/verification/${doc.id}/decision`, {
        decision,
        notes: text || undefined,
        checklist: [...ticked],
        timeSpentSeconds: Math.max(1, Math.round((Date.now() - openedAt) / 1000)),
        ...extra,
      });

      notify.success({
        approve: 'Verified.',
        reject: 'Rejected, and the client has been told.',
        request_changes: 'Sent back to the client for a corrected file.',
        raise_query: 'Question sent to the client.',
      }[decision]);

      await reload();
    } catch (err) {
      notifyError(err);
      busy(false);
    }
  }

  async function raiseQuery() {
    const answer = await modal({
      title: 'Ask the client a question',
      description: 'They are notified, and the document waits on their reply.',
      body: ({ close }) => {
        const subject = el('input.mm-input', {
          placeholder: 'Purchase invoice is missing its GSTIN', required: true,
        });
        const body = el('textarea.mm-input.mm-textarea', {
          rows: '4',
          placeholder: 'Describe exactly what you need. The clearer this is, the fewer rounds it takes.',
          required: true,
        });
        const category = el('select.mm-select',
          ...['document', 'data', 'clarification', 'missing', 'mismatch', 'other']
            .map(c => el('option', { value: c, text: fmt.label(c) })));
        const priority = el('select.mm-select',
          ...['low', 'normal', 'high', 'urgent'].map(p => el('option', {
            value: p, selected: p === 'normal', text: fmt.label(p),
          })));
        const errorHost = el('div');

        return el('form.mm-form', {
          novalidate: true,
          onSubmit: (e) => {
            e.preventDefault();
            if (!subject.value.trim() || !body.value.trim()) {
              errorHost.replaceChildren(el('p.mm-field__error', {
                role: 'alert', text: 'Both a subject and a description are needed.',
              }));
              return;
            }
            close({
              querySubject: subject.value.trim(),
              queryBody: body.value.trim(),
              queryCategory: category.value,
              queryPriority: priority.value,
            });
          },
        },
          errorHost,
          el('div.mm-field', el('label.mm-field__label', { text: 'Subject' }), subject),
          el('div.mm-field', el('label.mm-field__label', { text: 'What do you need?' }), body),
          el('div.mm-grid.mm-grid-2.mm-gap-3',
            el('div.mm-field', el('label.mm-field__label', { text: 'Category' }), category),
            el('div.mm-field', el('label.mm-field__label', { text: 'Priority' }), priority)),
          el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
            el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
            el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send question' })));
      },
    });
    if (answer) await decide('raise_query', answer);
  }

  const card_ = card({
    title: 'Your decision',
    subtitle: 'The checklist and the time spent are recorded with it.',
    body: frag(
      el('ul.mm-checklist.mm-checklist--interactive',
        ...CHECKS.map(check => el('li',
          el('label.mm-switch',
            el('input.mm-checkbox', {
              type: 'checkbox',
              onChange: (e) => { e.target.checked ? ticked.add(check.key) : ticked.delete(check.key); },
            }),
            el('span.mm-switch__text', el('span', { text: check.label })))))),

      el('div.mm-field.mm-mt-4',
        el('label.mm-field__label', { text: 'Notes' }),
        notes),

      el('div.mm-decision',
        button('Verify', {
          variant: 'primary', icon: 'check',
          onClick: () => decide('approve'),
          title: 'Marks it verified and locks the file',
        }),
        button('Ask the client', {
          variant: 'outline', icon: 'message-circle',
          onClick: raiseQuery,
          title: 'Raises a question and waits for their reply',
        }),
        button('Request a new file', {
          variant: 'outline', icon: 'upload',
          onClick: () => decide('request_changes'),
          title: 'Sends it back for a corrected upload',
        }),
        button('Reject', {
          variant: 'danger', icon: 'x',
          onClick: () => decide('reject'),
          title: 'Rejects it outright, with your reason',
        }))),
  });

  return card_;
}

function settledCard(doc) {
  const settled = ['verified', 'approved', 'archived'].includes(doc.status);
  return card({
    title: settled ? 'Already decided' : 'No decision available',
    body: el('div.mm-row.mm-gap-3.mm-center',
      icon(settled ? 'check-circle' : 'lock', { size: 'lg', className: settled ? 'mm-c-success' : 'mm-muted' }),
      el('div',
        el('p.mm-fw-medium', { text: `This document is ${fmt.label(doc.status).toLowerCase()}.` }),
        el('p.mm-muted.mm-text-sm', {
          text: settled
            ? (doc.verifiedAt ? `Decided ${fmt.dateTime(doc.verifiedAt)}.` : 'No further decision is needed.')
            : (doc.isLocked
                ? 'It is locked. Unlock it from the document record to review it again.'
                : 'Your role can read this document but not decide on it.'),
        }))),
  });
}

function historyCard(history) {
  return card({
    title: 'Decision history',
    flush: true,
    body: history.length
      ? el('ol.mm-timeline',
          ...history.map(record => el('li.mm-timeline__item',
            el('span.mm-timeline__dot', {
              class: `mm-timeline__dot--${record.decision === 'approved' ? 'success' : record.decision === 'rejected' ? 'danger' : 'warning'}`,
            }),
            el('div.mm-timeline__content',
              el('p.mm-timeline__title', {
                text: `${fmt.label(record.decision)} — ${record.verifier_name ?? 'a colleague'}`,
              }),
              record.notes ? el('p.mm-text-sm', { text: record.notes }) : null,
              el('p.mm-timeline__meta', {
                text: [
                  fmt.dateTime(record.created_at),
                  record.time_spent_seconds ? fmt.duration(record.time_spent_seconds) : null,
                  record.sla_met === 1 ? 'within SLA' : record.sla_met === 0 ? 'past SLA' : null,
                ].filter(Boolean).join(' · '),
              })))))
      : emptyState({ title: 'No decision has been recorded yet', icon: 'file-check', inline: true }),
  });
}

function queriesCard(queries) {
  return card({
    title: 'Open questions',
    flush: true,
    body: el('ul.mm-list',
      ...queries.map(query => el('li.mm-list__row',
        el('a.mm-list__main', { href: `/queries/${query.id}` },
          el('span.mm-fw-medium', { text: query.subject }),
          el('span.mm-muted.mm-text-xs', { text: fmt.relative(query.created_at) })),
        statusPill(query.status)))),
  });
}

function commentsCard(doc, comments, reload) {
  const input = el('textarea.mm-input.mm-textarea', {
    rows: '2', placeholder: 'Note for your colleagues…', 'aria-label': 'Internal note',
  });

  const form = el('form.mm-form.mm-mt-3', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      try {
        await api.post(`/documents/${doc.id}/comments`, { body, visibility: 'internal' });
        input.value = '';
        await reload();
      } catch (err) {
        notifyError(err);
        submitButton.disabled = false;
      }
    },
  },
    input,
    el('div.mm-row.mm-end.mm-mt-2',
      el('button.mm-btn.mm-btn--secondary.mm-btn--sm', { type: 'submit', text: 'Add note' })));

  return card({
    title: 'Notes',
    subtitle: 'Internal notes stay inside the firm. Clients never see them.',
    body: frag(
      comments.length
        ? el('ol.mm-thread',
            ...comments.map(comment => el('li.mm-thread__item',
              { class: comment.visibility === 'internal' ? 'is-internal' : '' },
              avatar(comment.author_name, { size: 'sm' }),
              el('div.mm-thread__body',
                el('div.mm-thread__head',
                  el('span.mm-fw-medium', { text: comment.author_name ?? 'Client' }),
                  comment.visibility === 'internal' ? pill('Internal', 'warning') : null,
                  el('span.mm-muted.mm-text-xs', { text: fmt.relative(comment.created_at) })),
                el('p.mm-thread__text', { text: comment.body })))))
        : el('p.mm-muted.mm-text-sm', { text: 'No notes yet.' }),
      session.can('documents.note.internal') ? form : null),
  });
}
