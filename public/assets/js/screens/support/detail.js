/**
 * One support ticket.
 *
 * The conversation, and the controls that change the ticket's state beside it.
 * A client is told plainly when internal notes exist that they cannot see —
 * the alternative is a thread that appears to have gaps in it.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, statusPill, pill, avatar, emptyState, errorState,
  notify, notifyError, modal, banner, skeletonTable, promptText,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function supportDetailScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(6, 2));

  async function load() {
    try {
      const { data } = await api.get(`/support/${params.id}`);
      setBreadcrumbs([
        { label: 'Support', href: '/support' },
        { label: data.ticket.ticketNo },
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
  const { ticket, messages, internalNotesHidden } = data;
  const closed = ['resolved', 'closed'].includes(ticket.status);
  const isStaff = !session.isClient();

  return [
    pageHead({
      title: ticket.subject,
      subtitle: [ticket.ticketNo, fmt.label(ticket.category), ticket.clientName].filter(Boolean).join(' · '),
      actions: frag(
        statusPill(ticket.status),
        isStaff && session.can('support.manage')
          ? button('Update', { variant: 'ghost', icon: 'edit', onClick: () => update(ticket, reload) })
          : null,
        isStaff && !closed && session.can('support.manage')
          ? button('Resolve', { variant: 'primary', icon: 'check', onClick: () => resolve(ticket, reload) })
          : null,
        !isStaff && ticket.status === 'resolved' && !ticket.satisfactionRating
          ? button('Rate the answer', { variant: 'primary', icon: 'check-circle', onClick: () => rate(ticket, reload) })
          : null),
    }),

    ticket.slaBreached && !closed
      ? banner({
          text: `This ticket has passed its SLA — it was due ${fmt.dateTime(ticket.slaDueAt)}.`,
          tone: 'danger',
          icon: 'alert',
        })
      : null,

    closed && ticket.resolution
      ? banner({ text: `Resolved: ${ticket.resolution}`, tone: 'success', icon: 'check-circle' })
      : null,

    internalNotesHidden
      ? banner({
          text: 'Some notes on this ticket are internal to your accountants and are not shown here.',
          tone: 'info',
          icon: 'lock',
        })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        conversationCard(ticket, messages ?? []),
        closed ? null : replyCard(ticket, reload)),

      el('div.mm-stack.mm-gap-4',
        detailsCard(ticket),
        ticket.satisfactionRating ? ratingCard(ticket) : null)),
  ].filter(Boolean);
}

function conversationCard(ticket, messages) {
  return card({
    title: 'Conversation',
    subtitle: `${fmt.plural(messages.length, 'message')} since ${fmt.date(ticket.createdAt)}`,
    body: el('ol.mm-thread',
      // The ticket's own description opens the thread rather than sitting
      // above it: it is the first message, and reads as one.
      el('li.mm-thread__item',
        avatar(ticket.raisedByName, { size: 'sm' }),
        el('div.mm-thread__body',
          el('div.mm-thread__head',
            el('span.mm-fw-medium', { text: ticket.raisedByName ?? 'The client' }),
            el('span.mm-muted.mm-text-xs', { text: fmt.relative(ticket.createdAt) })),
          el('p.mm-thread__text', { text: ticket.description }))),

      ...messages.map(message => el('li.mm-thread__item',
        { class: message.visibility === 'internal' ? 'is-internal' : '' },
        avatar(message.authorName, { size: 'sm' }),
        el('div.mm-thread__body',
          el('div.mm-thread__head',
            el('span.mm-fw-medium', { text: message.authorName ?? 'Support' }),
            message.authorKind ? pill(message.authorKind, 'neutral') : null,
            message.visibility === 'internal' ? pill('Internal note', 'warning') : null,
            el('span.mm-muted.mm-text-xs', { text: fmt.relative(message.createdAt) })),
          el('p.mm-thread__text', { text: message.body }),
          message.attachments?.length
            ? el('ul.mm-attachments',
                ...message.attachments.map(attachment => el('li',
                  el('span.mm-attachment',
                    icon('paperclip', { size: 'sm' }),
                    el('span', { text: attachment.fileName ?? attachment.name ?? 'Attachment' })))))
            : null)))),
  });
}

function replyCard(ticket, reload) {
  const input = el('textarea.mm-input.mm-textarea', {
    rows: '4', placeholder: 'Write your reply…', 'aria-label': 'Your reply',
  });
  const internal = el('input.mm-checkbox', { type: 'checkbox' });

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      try {
        await api.post(`/support/${ticket.id}/reply`, { body, internal: internal.checked });
        input.value = '';
        internal.checked = false;
        await reload();
      } catch (err) {
        notifyError(err);
        submitButton.disabled = false;
      }
    },
  },
    input,
    el('div.mm-row.mm-gap-3.mm-center.mm-mt-2',
      session.can('support.manage')
        ? el('label.mm-switch',
            internal,
            el('span.mm-switch__text',
              el('span', { text: 'Internal note' }),
              el('span.mm-muted.mm-text-xs.mm-block', { text: 'The client never sees this.' })))
        : null,
      el('span.mm-grow'),
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send' })));

  return card({ title: 'Reply', body: form });
}

function detailsCard(ticket) {
  return card({
    title: 'Ticket',
    body: el('div.mm-kvgrid',
      kv('Number', ticket.ticketNo, { mono: true }),
      kv('Category', fmt.label(ticket.category)),
      kv('Priority', fmt.label(ticket.priority)),
      kv('Raised by', ticket.raisedByName),
      kv('Client', ticket.clientName),
      kv('Channel', fmt.label(ticket.channel)),
      kv('Assigned to', ticket.assigneeName ?? 'Nobody'),
      kv('Raised', fmt.dateTime(ticket.createdAt)),
      kv('First reply', ticket.firstResponseAt ? fmt.dateTime(ticket.firstResponseAt) : 'Not yet'),
      kv('SLA due', ticket.slaDueAt ? fmt.dateTime(ticket.slaDueAt) : null),
      kv('Resolved', ticket.resolvedAt ? fmt.dateTime(ticket.resolvedAt) : null),
      kv('Reopened', ticket.reopenCount || null)),
  });
}

function ratingCard(ticket) {
  return card({
    title: 'How it was rated',
    body: el('div.mm-row.mm-gap-2.mm-center',
      ...Array.from({ length: 5 }, (_, i) => icon('check-circle', {
        size: 'sm',
        className: i < ticket.satisfactionRating ? 'mm-c-success' : 'mm-muted',
      })),
      el('span.mm-fw-medium', { text: `${ticket.satisfactionRating}/5` })),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function update(ticket, reload) {
  const people = await api.get('/users', { pageSize: 100 }).then(r => r.data ?? []).catch(() => []);

  const payload = await modal({
    title: `Update ${ticket.ticketNo}`,
    size: 'sm',
    body: ({ close }) => {
      const status = el('select.mm-select',
        ...['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'resolved', 'closed', 'reopened']
          .map(s => el('option', { value: s, selected: s === ticket.status, text: fmt.label(s) })));
      const priority = el('select.mm-select',
        ...['low', 'normal', 'high', 'urgent'].map(p => el('option', {
          value: p, selected: p === ticket.priority, text: fmt.label(p),
        })));
      const assignee = el('select.mm-select',
        el('option', { value: '', text: 'Nobody' }),
        ...people.map(p => el('option', {
          value: p.id, selected: p.id === ticket.assignedTo, text: p.fullName,
        })));

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            status: status.value,
            priority: priority.value,
            assignedTo: assignee.value || undefined,
          });
        },
      },
        el('div.mm-field', el('label.mm-field__label', { text: 'Status' }), status),
        el('div.mm-field', el('label.mm-field__label', { text: 'Priority' }), priority),
        el('div.mm-field', el('label.mm-field__label', { text: 'Assigned to' }), assignee),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!payload) return;

  try {
    await api.patch(`/support/${ticket.id}`, payload);
    notify.success('Updated.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function resolve(ticket, reload) {
  const resolution = await promptText({
    title: `Resolve ${ticket.ticketNo}`,
    message: 'The client is told, and asked to rate the answer.',
    label: 'How was it resolved?',
    placeholder: 'Increased the per-file limit and confirmed the upload went through.',
    confirmLabel: 'Resolve',
  });
  if (!resolution) return;

  try {
    await api.patch(`/support/${ticket.id}`, { status: 'resolved', resolution });
    notify.success('Resolved.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function rate(ticket, reload) {
  const payload = await modal({
    title: 'How did we do?',
    size: 'sm',
    body: ({ close }) => {
      let chosen = 0;
      const buttons = [];
      const comment = el('textarea.mm-input.mm-textarea', { rows: '3', placeholder: 'Anything you would like to add?' });

      const paint = () => buttons.forEach((b, i) => b.classList.toggle('is-chosen', i < chosen));

      for (let i = 1; i <= 5; i += 1) {
        const button_ = el('button.mm-rate__star', {
          type: 'button',
          'aria-label': `${i} out of 5`,
          onClick: () => { chosen = i; paint(); },
        }, icon('check-circle'));
        buttons.push(button_);
      }

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!chosen) return;
          close({ rating: chosen, comment: comment.value.trim() || undefined });
        },
      },
        el('div.mm-row.mm-gap-2.mm-center', ...buttons),
        el('div.mm-field.mm-mt-3', el('label.mm-field__label', { text: 'Comment' }), comment),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Not now', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send' })));
    },
  });
  if (!payload) return;

  try {
    await api.post(`/support/${ticket.id}/rate`, payload);
    notify.success('Thank you.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
