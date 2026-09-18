/**
 * The chat inbox.
 *
 * Conversations on the left, the open one on the right — the shape every
 * messaging interface uses, because it is the one people already know.
 *
 * WhatsApp's 24-hour rule is shown rather than discovered: once the window has
 * closed, free text is refused by Meta and only an approved template gets
 * through. Saying so before somebody types is the difference between a
 * message that arrives and one that silently does not.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, avatar, emptyState, errorState,
  skeletonTable, notify, notifyError, banner, modal, lockedState,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function inboxScreen({ query }) {
  setBreadcrumbs([{ label: 'Chat inbox' }]);

  const page = el('div.mm-page');
  const listHost = el('div.mm-split__list');
  const threadHost = el('div.mm-split__detail');

  let threads = [];
  let meta = {};
  let activeId = query.get('thread');

  async function loadList() {
    try {
      const result = await api.get('/messaging/threads', { pageSize: 100 });
      threads = result.data ?? [];
      meta = result.meta ?? {};
      paintList();
      if (!activeId && threads.length) {
        activeId = threads[0].id;
        router.setQuery({ thread: activeId });
      }
      if (activeId) await loadThread();
    } catch (err) {
      if (err.name === 'FeatureLocked') {
        render(page,
          pageHead({ title: 'Chat inbox' }),
          lockedState({
            featureName: 'WhatsApp inbox',
            requiredAddOn: 'whatsapp_business_api',
            message: 'Two-way WhatsApp inside the CRM, with templates, media and document collection.',
          }));
        return;
      }
      render(listHost, errorState(err, { onRetry: loadList }));
    }
  }

  function paintList() {
    render(listHost, card({
      title: 'Conversations',
      subtitle: meta.summary
        ? `${meta.summary.open} open · ${meta.summary.unread} unread`
        : null,
      flush: true,
      body: threads.length
        ? el('ul.mm-list',
            ...threads.map(thread => el('li.mm-list__row', {
              class: thread.id === activeId ? 'is-active' : '',
              onClick: () => {
                activeId = thread.id;
                router.setQuery({ thread: thread.id });
                paintList();
                loadThread();
              },
            },
              avatar(thread.displayName ?? thread.clientName, { size: 'sm' }),
              el('div.mm-list__main',
                el('span.mm-fw-medium', { text: thread.displayName ?? thread.phone }),
                el('span.mm-muted.mm-text-xs', { text: thread.lastMessagePreview ?? thread.clientName ?? '' })),
              el('div.mm-stack.mm-align-right',
                el('span.mm-muted.mm-text-xs', { text: fmt.relative(thread.lastMessageAt) }),
                thread.unreadCount
                  ? el('span.mm-nav-item__badge', { text: String(thread.unreadCount) })
                  : null))))
        : emptyState({
            title: 'No conversations',
            message: 'A conversation starts when a client messages your WhatsApp number, or when you message them.',
            icon: 'message-circle',
            inline: true,
          }),
    }));
  }

  async function loadThread() {
    render(threadHost, skeletonTable(6, 2));
    try {
      const { data } = await api.get(`/messaging/threads/${activeId}`);
      render(threadHost, threadPane(data, { reload: loadThread, reloadList: loadList }));
    } catch (err) {
      render(threadHost, errorState(err, { onRetry: loadThread }));
    }
  }

  page.append(
    pageHead({
      title: 'Chat inbox',
      subtitle: 'WhatsApp and SMS conversations with your clients.',
      actions: session.can('messaging.broadcast')
        ? button('Broadcast', { variant: 'ghost', icon: 'bell-ring', onClick: () => openBroadcast() })
        : null,
    }),
    el('div.mm-split', listHost, threadHost));

  await loadList();
  return page;
}

function threadPane(data, { reload, reloadList }) {
  const { thread, messages, client, window: chatWindow, templates } = data;

  return el('div.mm-stack.mm-gap-4',
    card({
      title: thread.displayName ?? thread.phone,
      subtitle: [thread.clientName, thread.phone, fmt.label(thread.channel)].filter(Boolean).join(' · '),
      actions: frag(
        statusPill(thread.status),
        client
          ? button('Open the client', { variant: 'ghost', size: 'sm', href: `/clients/${client.id}` })
          : null),
      body: messages.length
        ? el('ol.mm-chat',
            ...messages.map(message => el('li.mm-chat__msg', {
              class: message.direction === 'outbound' ? 'is-out' : 'is-in',
            },
              el('div.mm-chat__bubble',
                message.type !== 'text'
                  ? el('span.mm-chat__media',
                      icon('paperclip', { size: 'sm' }),
                      el('span', { text: message.mediaName ?? fmt.label(message.type) }))
                  : null,
                message.body ? el('p', { text: message.body }) : null,
                el('span.mm-chat__meta',
                  message.senderName ? el('span', { text: message.senderName }) : null,
                  el('span', { text: fmt.relative(message.createdAt) }),
                  message.direction === 'outbound'
                    ? el('span', { class: message.status === 'failed' ? 'mm-c-danger' : '', text: fmt.label(message.status) })
                    : null)),
              message.error ? el('span.mm-c-danger.mm-text-xs', { text: message.error }) : null)))
        : el('p.mm-muted.mm-text-sm', { text: 'No messages in this conversation yet.' }),
    }),

    chatWindow?.open
      ? replyCard(thread, reload, reloadList)
      : templateCard(thread, chatWindow, templates ?? [], reload, reloadList));
}

/** Free text, while the 24-hour window is open. */
function replyCard(thread, reload, reloadList) {
  const input = el('textarea.mm-input.mm-textarea', {
    rows: '3', placeholder: 'Type a reply…', 'aria-label': 'Your message',
  });

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      try {
        await api.post(`/messaging/threads/${thread.id}/reply`, { body });
        input.value = '';
        await reload();
        await reloadList();
      } catch (err) {
        notifyError(err);
      } finally {
        submitButton.disabled = false;
      }
    },
  },
    input,
    el('div.mm-row.mm-end.mm-gap-2.mm-mt-2',
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send' })));

  return card({
    title: 'Reply',
    subtitle: 'The conversation window is open, so an ordinary message goes through.',
    body: form,
  });
}

/**
 * Outside the window, only an approved template is delivered.
 *
 * The rule is Meta's, not ours, and it is stated here with the reason — a
 * "send" button that quietly fails is worse than one that is not offered.
 */
function templateCard(thread, chatWindow, templates, reload, reloadList) {
  if (!templates.length) {
    return card({
      title: 'This conversation is closed',
      body: frag(
        banner({
          text: chatWindow?.reason ?? 'More than 24 hours have passed since the client’s last message, so WhatsApp only accepts an approved template.',
          tone: 'warning',
          icon: 'clock',
        }),
        el('p.mm-muted.mm-text-sm.mm-mt-3', {
          text: 'No approved templates are available on this deployment, so nothing can be sent until the client messages again.',
        })),
    });
  }

  const select = el('select.mm-select',
    ...templates.map(t => el('option', { value: t.id, text: `${t.name} (${t.language})` })));
  const preview = el('p.mm-prose.mm-mt-2');

  const paintPreview = () => {
    const template = templates.find(t => t.id === select.value) ?? templates[0];
    preview.textContent = template?.body ?? '';
  };
  select.addEventListener('change', paintPreview);
  paintPreview();

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      try {
        await api.post(`/messaging/threads/${thread.id}/reply`, { templateId: select.value });
        notify.success('Template sent.');
        await reload();
        await reloadList();
      } catch (err) {
        notifyError(err);
      } finally {
        submitButton.disabled = false;
      }
    },
  },
    el('div.mm-field', el('label.mm-field__label', { text: 'Template' }), select),
    preview,
    el('div.mm-row.mm-end.mm-mt-3',
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send the template' })));

  return card({
    title: 'Send a template',
    body: frag(
      banner({
        text: chatWindow?.reason ?? 'The 24-hour window has closed, so only an approved template will be delivered.',
        tone: 'warning',
        icon: 'clock',
      }),
      form),
  });
}

/**
 * A broadcast.
 *
 * The audience is a description the server resolves, not a list this screen
 * builds — so the recipient count is the server's own count and cannot drift
 * from what is actually sent.
 */
async function openBroadcast() {
  const payload = await modal({
    title: 'Broadcast',
    description: 'Sent as an approved template. WhatsApp refuses free text outside a reply window, so a template is required.',
    body: ({ close }) => {
      const name = el('input.mm-input', { placeholder: 'September filing reminder', required: true });
      const templates = el('select.mm-select', el('option', { value: '', text: 'Loading templates…' }));
      const status = el('select.mm-select',
        el('option', { value: '', text: 'Every client' }),
        ...['active', 'onboarding', 'paused'].map(v => el('option', { value: v, text: `${fmt.label(v)} clients only` })));
      const mineOnly = el('input.mm-checkbox', { type: 'checkbox' });
      const errorHost = el('div');
      const countNode = el('p.mm-field__hint');

      api.get('/messaging/templates')
        .then(({ data }) => {
          const approved = (data ?? []).filter(t => (t.approvalStatus ?? t.approval_status) === 'approved');
          render(templates, ...(approved.length
            ? approved.map(t => el('option', { value: t.id, text: `${t.name} (${t.language ?? 'en'})` }))
            : [el('option', { value: '', text: 'No approved templates on this deployment' })]));
          if (!approved.length) {
            countNode.textContent = 'Meta must approve a template before it can be broadcast.';
          }
        })
        .catch(() => render(templates, el('option', { value: '', text: 'Could not load templates' })));

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Give the broadcast a name for the record.' }));
            return;
          }
          if (!templates.value) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'A WhatsApp broadcast needs an approved template.',
            }));
            return;
          }
          close({
            name: name.value.trim(),
            channel: 'whatsapp',
            templateId: templates.value,
            audience: {
              kind: 'clients',
              status: status.value || undefined,
              assignedTo: mineOnly.checked ? session.session().user?.id : undefined,
            },
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), name),
        el('div.mm-field', el('label.mm-field__label', { text: 'Template' }), templates, countNode),
        el('div.mm-field', el('label.mm-field__label', { text: 'Who receives it' }), status),
        el('label.mm-switch',
          mineOnly,
          el('span.mm-switch__text', el('span', { text: 'Only clients assigned to me' }))),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/messaging/broadcasts', payload);
    notify.success(`Queued for ${fmt.plural(data?.broadcast?.recipient_count ?? data?.recipients ?? 0, 'recipient')}.`);
  } catch (err) {
    notifyError(err);
  }
}
