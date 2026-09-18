/**
 * One question, and the conversation on it.
 *
 * Read as a thread rather than a record: the point is the exchange. A client
 * sees only what was shared with them — the server enforces that, and this
 * screen marks internal notes clearly so nobody writes one by accident.
 *
 * The reply box can carry a corrected file, because "upload the right one" is
 * the answer to most questions and making somebody leave for the upload screen
 * loses the thread they were answering.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, statusPill, pill, avatar, emptyState, errorState,
  notify, notifyError, banner, skeletonTable, promptText,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function queryThreadScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(6, 2));

  async function load() {
    try {
      const { data } = await api.get(`/queries/${params.id}`);
      setBreadcrumbs([
        { label: session.isClient() ? 'Questions' : 'Queries', href: session.isClient() ? '/client/queries' : '/queries' },
        { label: data.query.referenceNo ?? data.query.subject },
      ]);
      render(page, ...build(data, load));
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, reload) {
  const { query, replies, client, document: doc, period, permissions } = data;
  const closed = ['resolved', 'cancelled'].includes(query.status);

  return [
    pageHead({
      title: query.subject,
      subtitle: [query.referenceNo, client?.display_name, fmt.label(query.category)]
        .filter(Boolean).join(' · '),
      actions: frag(
        statusPill(query.status),
        query.priority && query.priority !== 'normal'
          ? pill(query.priority, query.priority === 'urgent' ? 'danger' : 'warning')
          : null,
        !closed && permissions?.canResolve
          ? button('Mark resolved', { variant: 'primary', icon: 'check', onClick: () => resolve(query, reload) })
          : null,
        closed && permissions?.canResolve
          ? button('Reopen', { variant: 'ghost', icon: 'refresh', onClick: () => reopen(query, reload) })
          : null),
    }),

    closed
      ? banner({
          text: query.resolutionNote
            ? `Resolved: ${query.resolutionNote}`
            : `Resolved ${fmt.dateTime(query.resolvedAt)}.`,
          tone: 'success',
          icon: 'check-circle',
        })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        threadCard(query, replies ?? []),
        !closed && permissions?.canReply ? replyCard(query, permissions, reload) : null),

      el('div.mm-stack.mm-gap-4',
        aboutCard(query, client, doc, period),
        doc ? documentCard(doc) : null)),
  ].filter(Boolean);
}

function threadCard(query, replies) {
  return card({
    title: 'The conversation',
    subtitle: `${fmt.plural(replies.length, 'reply', 'replies')} since ${fmt.date(query.createdAt)}`,
    body: el('ol.mm-thread',
      // The question itself is the first message in the thread, not a header
      // above it — it is part of the conversation and reads that way.
      el('li.mm-thread__item',
        avatar(query.raisedByName, { size: 'sm' }),
        el('div.mm-thread__body',
          el('div.mm-thread__head',
            el('span.mm-fw-medium', { text: query.raisedByName ?? 'Your accountant' }),
            pill('Question', 'info'),
            el('span.mm-muted.mm-text-xs', {
              title: fmt.dateTime(query.createdAt),
              text: fmt.relative(query.createdAt),
            })),
          el('p.mm-thread__text', { text: query.body }))),

      ...replies.map(reply => el('li.mm-thread__item',
        { class: reply.visibility === 'internal' ? 'is-internal' : '' },
        avatar(reply.author_name, { size: 'sm' }),
        el('div.mm-thread__body',
          el('div.mm-thread__head',
            el('span.mm-fw-medium', { text: reply.author_name ?? 'The client' }),
            reply.visibility === 'internal' ? pill('Internal note', 'warning') : null,
            reply.channel && reply.channel !== 'portal'
              ? pill(reply.channel, 'neutral')
              : null,
            el('span.mm-muted.mm-text-xs', {
              title: fmt.dateTime(reply.created_at),
              text: fmt.relative(reply.created_at),
            })),
          el('p.mm-thread__text', { text: reply.body }),
          reply.attachments?.length
            ? el('ul.mm-attachments',
                ...reply.attachments.map(attachment => el('li',
                  el('a.mm-attachment', {
                    href: attachment.documentId ? `/documents/${attachment.documentId}` : '#',
                  },
                    icon('paperclip', { size: 'sm' }),
                    el('span', { text: attachment.fileName ?? attachment.name ?? 'Attachment' })))))
            : null)))),
  });
}

/**
 * The reply box.
 *
 * A file attached here is uploaded as a new version of the document the
 * question was raised against — which is what "here is the corrected one"
 * means, and it keeps the version history intact.
 */
function replyCard(query, permissions, reload) {
  const input = el('textarea.mm-input.mm-textarea', {
    rows: '4',
    placeholder: session.isClient()
      ? 'Reply to your accountant…'
      : 'Reply to the client…',
    'aria-label': 'Your reply',
  });

  const fileInput = el('input.mm-input', { type: 'file' });
  const fileField = permissions?.canUploadCorrection && query.documentId
    ? el('div.mm-field',
        el('label.mm-field__label', { text: 'Attach a corrected file (optional)' }),
        fileInput,
        el('p.mm-field__hint', {
          text: 'It is added as a new version of the document, and the old one is kept.',
        }))
    : null;

  const visibility = el('select.mm-select',
    el('option', { value: 'shared', text: session.isClient() ? 'Reply' : 'Visible to the client' }),
    permissions?.canAddInternalNote
      ? el('option', { value: 'internal', text: 'Internal note' })
      : null);

  const resolveToggle = el('input.mm-checkbox', { type: 'checkbox' });

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      const file = fileInput.files?.[0] ?? null;

      if (!body && !file) {
        notify.warning('Write a reply, or attach the corrected file.');
        input.focus();
        return;
      }

      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      submitButton.textContent = 'Sending…';

      try {
        // The file goes first: if the upload fails, the reply is not sent
        // saying a file was attached when it was not.
        if (file) {
          const payload = new FormData();
          payload.append('file', file, file.name);
          payload.set('queryId', query.id);
          if (body) payload.set('note', body);
          await api.upload(`/documents/${query.documentId}/versions`, payload);
        }

        if (body) {
          await api.post(`/queries/${query.id}/replies`, {
            body,
            visibility: visibility.value,
            resolve: resolveToggle.checked,
          });
        }

        notify.success(file && body ? 'Reply and corrected file sent.' : file ? 'Corrected file uploaded.' : 'Reply sent.');
        await reload();
      } catch (err) {
        notifyError(err);
        submitButton.disabled = false;
        submitButton.textContent = 'Send reply';
      }
    },
  },
    input,
    fileField,
    el('div.mm-row.mm-gap-3.mm-center.mm-wrap.mm-mt-3',
      visibility,
      permissions?.canResolve
        ? el('label.mm-switch',
            resolveToggle,
            el('span.mm-switch__text', el('span', { text: 'Mark resolved as well' })))
        : null,
      el('span.mm-grow'),
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send reply' })));

  return card({ title: 'Your reply', body: form });
}

function aboutCard(query, client, doc, period) {
  return card({
    title: 'About this question',
    body: el('div.mm-kvgrid',
      kv('Reference', query.referenceNo, { mono: true }),
      kv('Client', client?.display_name),
      kv('Contact', client?.primary_contact_name),
      kv('Category', fmt.label(query.category)),
      kv('Priority', fmt.label(query.priority)),
      kv('Raised by', query.raisedByName),
      kv('Raised', fmt.dateTime(query.createdAt)),
      kv('First response', query.firstResponseAt ? fmt.dateTime(query.firstResponseAt) : 'Not yet'),
      kv('Due', query.dueAt ? fmt.dateTime(query.dueAt) : null),
      kv('Period', period?.period_key ? fmt.period(period.period_key) : null),
      kv('Resolved', query.resolvedAt ? fmt.dateTime(query.resolvedAt) : null)),
  });
}

function documentCard(doc) {
  return card({
    title: 'The document in question',
    flush: true,
    body: el('ul.mm-list',
      el('li.mm-list__row',
        el('span.mm-list__icon.mm-muted', icon('file', { size: 'sm' })),
        el('a.mm-list__main', { href: `/documents/${doc.id}` },
          el('span.mm-fw-medium', { text: doc.title }),
          el('span.mm-muted.mm-text-xs', {
            text: [fmt.period(doc.period_key), `v${doc.version_count}`].filter(Boolean).join(' · '),
          })),
        statusPill(doc.status))),
  });
}

async function resolve(query, reload) {
  const note = await promptText({
    title: 'Mark this resolved',
    message: 'The client is told it is settled. The document it was raised against is released back into the queue.',
    label: 'How was it resolved?',
    placeholder: 'Client sent the corrected invoice with the GSTIN.',
    required: false,
    confirmLabel: 'Resolve',
  });
  // promptText resolves to null on cancel and '' when submitted empty, which
  // is allowed here — the note is optional.
  if (note === null) return;

  try {
    await api.post(`/queries/${query.id}/resolve`, {
      resolutionNote: note || undefined,
      releaseDocument: true,
    });
    notify.success('Resolved.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function reopen(query, reload) {
  const reason = await promptText({
    title: 'Reopen this question',
    message: 'It goes back to the client as open, and the document waits on it again.',
    label: 'Why is it being reopened?',
    placeholder: 'The replacement invoice still has the wrong GSTIN.',
    confirmLabel: 'Reopen',
  });
  if (!reason) return;

  try {
    await api.post(`/queries/${query.id}/reopen`, { reason });
    notify.success('Reopened.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
