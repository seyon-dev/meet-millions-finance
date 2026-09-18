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
  skeletonTable, notify, notifyError, banner, modal, lockedState, confirm,
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
      actions: frag(
        session.can('messaging.templates')
          ? button('Chatbot flows', { variant: 'ghost', icon: 'zap', onClick: () => openFlows() })
          : null,
        session.can('messaging.broadcast')
          ? button('Broadcast', { variant: 'ghost', icon: 'bell-ring', onClick: () => openBroadcast() })
          : null),
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
/**
 * Chatbot flows.
 *
 * A flow is a small graph: each node says something, and a question node
 * branches on the answer. The builder is a list of nodes rather than a canvas
 * — a canvas looks impressive and is worse to use on a phone, and every flow
 * this is for is under a dozen nodes.
 *
 * Nothing here can be saved without passing the same validation the API
 * applies, and "Test it" replays the flow against nobody so a broken branch is
 * found here rather than by a client.
 */
async function openFlows() {
  await modal({
    title: 'Chatbot flows',
    size: 'lg',
    body: ({ close }) => {
      const host = el('div');

      async function refresh() {
        render(host, el('div.mm-row.mm-gap-2', el('span.mm-spinner'), el('span', { text: 'Loading flows…' })));
        try {
          const { data } = await api.get('/messaging/flows');
          render(host, list(data.flows ?? []));
        } catch (err) {
          render(host, errorState(err, { onRetry: refresh }));
        }
      }

      function list(flows) {
        return el('div.mm-stack.mm-gap-3',
          el('div.mm-row.mm-gap-2',
            el('span.mm-muted.mm-text-sm', {
              text: flows.length
                ? `${flows.filter(f => f.isActive).length} of ${flows.length} active. `
                  + 'An active flow answers any message containing one of its keywords.'
                : 'No flows yet. A flow answers common questions automatically and hands over when it cannot.',
            }),
            el('span.mm-grow'),
            button('New flow', { variant: 'primary', icon: 'plus', size: 'sm', onClick: () => editFlow(null, refresh) })),

          flows.length
            ? el('ul.mm-list',
                ...flows.map(f => el('li.mm-list__row',
                  el('span.mm-list__icon', icon(f.isActive ? 'zap' : 'pause', { size: 'sm' })),
                  el('div.mm-list__main',
                    el('span.mm-fw-medium', { text: f.name }),
                    el('span.mm-muted.mm-text-xs', {
                      text: [
                        `${f.nodes.length} step${f.nodes.length === 1 ? '' : 's'}`,
                        f.triggerKeywords.length ? `triggers: ${f.triggerKeywords.join(', ')}` : 'no triggers',
                        f.fallbackToHuman ? 'hands over when stuck' : 'no handover',
                      ].join(' · '),
                    })),
                  pill(f.isActive ? 'Active' : 'Off', f.isActive ? 'success' : 'neutral'),
                  button('Test', { variant: 'ghost', size: 'sm', onClick: () => simulate(f) }),
                  button('Edit', { variant: 'ghost', size: 'sm', onClick: () => editFlow(f, refresh) }))))
            : emptyState({
                title: 'No chatbot flows',
                message: 'Build one to answer status questions and collect documents without anybody typing.',
                icon: 'zap',
                inline: true,
              }));
      }

      refresh();
      return host;
    },
  });
}

async function editFlow(existing, reload) {
  // Start from a working two-step flow rather than an empty canvas: an empty
  // builder is the hardest thing to begin with, and this one is valid as-is.
  const starting = existing?.nodes?.length ? existing.nodes : [
    {
      id: 'ask',
      type: 'question',
      prompt: 'Hello! What can I help you with?',
      options: [
        { label: 'My filing status', keywords: ['status', 'filing'], next: 'status' },
        { label: 'Send a document', keywords: ['document', 'upload'], next: 'collect' },
        { label: 'Talk to someone', keywords: ['human', 'person'], next: 'human' },
      ],
      retryPrompt: 'Sorry, I did not follow. Let me get someone to help.',
    },
    { id: 'status', type: 'status', prompt: 'Checking your filing…' },
    { id: 'collect', type: 'collect_document', prompt: 'Please send the document here and we will file it.' },
    { id: 'human', type: 'handover', prompt: 'One moment — connecting you to your executive.' },
  ];

  await modal({
    title: existing ? `Edit “${existing.name}”` : 'New chatbot flow',
    size: 'lg',
    body: ({ close }) => {
      const name = el('input.mm-input', { value: existing?.name ?? '', placeholder: 'Filing status bot' });
      const keywords = el('input.mm-input', {
        value: (existing?.triggerKeywords ?? ['status', 'hello']).join(', '),
        placeholder: 'status, hello, help',
      });
      const nodesField = el('textarea.mm-input.mm-textarea', {
        rows: 14,
        spellcheck: 'false',
        value: JSON.stringify(starting, null, 2),
      });
      const entry = el('input.mm-input', { value: existing?.entryNodeId ?? 'ask', placeholder: 'ask' });
      const active = el('input', { type: 'checkbox', checked: existing?.isActive ?? false });
      const fallback = el('input', { type: 'checkbox', checked: existing?.fallbackToHuman ?? true });

      const save = button(existing ? 'Save flow' : 'Create flow', {
        variant: 'primary',
        onClick: async () => {
          let nodes;
          try {
            nodes = JSON.parse(nodesField.value);
          } catch (err) {
            notify.warning(`The steps are not valid JSON: ${err.message}`);
            return;
          }
          const payload = {
            name: name.value.trim(),
            triggerKeywords: keywords.value.split(',').map(k => k.trim()).filter(Boolean),
            nodes,
            entryNodeId: entry.value.trim(),
            isActive: active.checked,
            fallbackToHuman: fallback.checked,
          };
          if (!payload.name) { notify.warning('Give the flow a name.'); name.focus(); return; }

          save.disabled = true;
          try {
            if (existing) await api.patch(`/messaging/flows/${existing.id}`, payload);
            else await api.post('/messaging/flows', payload);
            notify.success(existing ? 'Flow saved.' : 'Flow created.');
            close();
            reload();
          } catch (err) {
            // The API validates the graph — a dangling jump comes back as a
            // readable sentence, so show it rather than a generic failure.
            notifyError(err);
            save.disabled = false;
          }
        },
      });

      const remove = existing
        ? button('Delete', {
            variant: 'ghost', icon: 'trash',
            onClick: async () => {
              const yes = await confirm({
                title: `Delete “${existing.name}”?`,
                message: 'Any conversation currently inside this flow is handed to a person. '
                  + 'Messages already sent are kept.',
                confirmLabel: 'Delete flow',
                tone: 'danger',
              });
              if (!yes) return;
              try {
                await api.delete(`/messaging/flows/${existing.id}`);
                notify.success('Flow deleted.');
                close();
                reload();
              } catch (err) { notifyError(err); }
            },
          })
        : null;

      return el('div.mm-stack.mm-gap-3',
        el('label.mm-field', el('span.mm-field__label', { text: 'Name' }), name),
        el('label.mm-field',
          el('span.mm-field__label', { text: 'Trigger keywords (comma separated)' }), keywords),
        el('label.mm-field', el('span.mm-field__label', { text: 'First step id' }), entry),
        el('label.mm-field',
          el('span.mm-field__label', { text: 'Steps' }),
          nodesField,
          el('span.mm-muted.mm-text-xs', {
            text: 'Types: message, question, status, collect_document, handover. '
              + 'A question needs options, each with a "next". "status" reads the real filing record.',
          })),
        el('div.mm-row.mm-gap-4',
          el('label.mm-row.mm-gap-2', active, el('span.mm-text-sm', { text: 'Active' })),
          el('label.mm-row.mm-gap-2', fallback, el('span.mm-text-sm', { text: 'Hand over when stuck' }))),
        el('div.mm-row.mm-gap-2', remove, el('span.mm-grow'), save));
    },
  });
}

/** Replay a flow against nobody, and show what it would have said. */
async function simulate(flow) {
  await modal({
    title: `Test “${flow.name}”`,
    size: 'md',
    body: () => {
      const host = el('div');
      const input = el('input.mm-input', { placeholder: 'Type a reply, then Send' });
      const replies = [];

      async function run() {
        render(host, el('div.mm-row.mm-gap-2', el('span.mm-spinner'), el('span', { text: 'Running…' })));
        try {
          const { data } = await api.post(`/messaging/flows/${flow.id}/simulate`, { replies });
          render(host,
            el('div.mm-transcript.mm-transcript--sim',
              ...(data.transcript ?? []).map(line => el('div.mm-transcript__line',
                el('span.mm-transcript__speaker', { text: line.from === 'bot' ? 'Bot' : 'Client' }),
                el('span.mm-transcript__text', { text: line.text })))),
            el('p.mm-muted.mm-text-xs.mm-mt-2', { text: data.note ?? '' }));
        } catch (err) {
          render(host, errorState(err, { onRetry: run }));
        }
      }

      const send = button('Send', {
        variant: 'secondary', size: 'sm',
        onClick: () => {
          if (!input.value.trim()) return;
          replies.push(input.value.trim());
          input.value = '';
          run();
        },
      });

      run();
      return el('div.mm-stack.mm-gap-3',
        host,
        el('div.mm-row.mm-gap-2', input, send),
        el('p.mm-muted.mm-text-xs', {
          text: 'Nothing is sent to anybody. The filing-status step reads a real record only when a '
            + 'conversation is linked to a client, so it hands over here.',
        }));
    },
  });
}

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
