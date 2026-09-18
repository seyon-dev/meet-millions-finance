/**
 * The tax assistant.
 *
 * A conversation, with one rule held to throughout: every answer says whether
 * it was grounded in this organisation's own figures or is general guidance,
 * and where grounded, it cites the records it used. An assistant that cannot
 * tell you which is which is an assistant an accountant cannot use.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, button, pill, avatar, emptyState, errorState, skeletonTable,
  notify, notifyError, banner, lockedState,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

const SUGGESTIONS = [
  'What is my net GST payable this month, and which client drives most of it?',
  'Which clients still have documents waiting for verification?',
  'Summarise what changed in GST rates that affects my clients.',
  'How much is outstanding across all invoices, and how old is the oldest?',
];

export default async function assistantScreen({ query }) {
  setBreadcrumbs([{ label: 'Tax assistant' }]);

  const page = el('div.mm-page');
  const threadHost = el('div');
  const sideHost = el('div.mm-stack.mm-gap-4');

  let conversationId = query.get('c') ?? null;
  let messages = [];
  let status = null;

  try {
    ({ data: status } = await api.get('/ai/status'));
  } catch (err) {
    if (err.name === 'FeatureLocked') {
      render(page,
        pageHead({ title: 'Tax assistant' }),
        lockedState({
          featureName: 'The AI tax assistant',
          requiredAddOn: 'ai_tax_assistant',
          message: 'Ask questions about GST and TDS and about your own clients’ figures, in plain language.',
        }));
      return page;
    }
    render(page, errorState(err));
    return page;
  }

  const capability = (status.capabilities ?? []).find(c => c.key === 'assistant' || c.key === 'llm');
  const ready = capability ? capability.configured && capability.featureUnlocked : false;

  async function loadConversation() {
    if (!conversationId) { messages = []; paintThread(); return; }
    render(threadHost, skeletonTable(5, 2));
    try {
      const { data } = await api.get(`/ai/conversations/${conversationId}`);
      messages = data.messages ?? [];
      paintThread();
    } catch (err) {
      render(threadHost, errorState(err, { onRetry: loadConversation }));
    }
  }

  async function loadHistory() {
    try {
      const { data } = await api.get('/ai/conversations');
      render(sideHost,
        card({
          title: 'Your conversations',
          actions: button('New', {
            variant: 'ghost', size: 'sm', icon: 'plus',
            onClick: () => { conversationId = null; router.setQuery({ c: null }); loadConversation(); },
          }),
          flush: true,
          body: (data.conversations ?? []).length
            ? el('ul.mm-list',
                ...data.conversations.map(conversation => el('li.mm-list__row', {
                  class: conversation.id === conversationId ? 'is-active' : '',
                  onClick: () => {
                    conversationId = conversation.id;
                    router.setQuery({ c: conversation.id });
                    loadConversation();
                    loadHistory();
                  },
                },
                  el('div.mm-list__main',
                    el('span.mm-fw-medium', { text: conversation.title ?? 'Untitled' }),
                    el('span.mm-muted.mm-text-xs', {
                      text: `${fmt.plural(conversation.messageCount ?? 0, 'message')} · ${fmt.relative(conversation.updatedAt)}`,
                    })))))
            : el('p.mm-muted.mm-text-sm.mm-p-4', { text: 'Nothing yet. Ask something below.' }),
        }),
        capabilityCard(status));
    } catch {
      render(sideHost, capabilityCard(status));
    }
  }

  function paintThread() {
    if (!messages.length) {
      render(threadHost, card({
        body: frag(
          emptyState({
            title: 'Ask about GST, TDS or your own clients',
            message: 'Answers about your figures cite the records they came from. Anything general is labelled as general.',
            icon: 'sparkle',
            inline: true,
          }),
          el('div.mm-row.mm-gap-2.mm-wrap.mm-mt-4.mm-center',
            ...SUGGESTIONS.map(text => el('button.mm-chip', {
              type: 'button',
              text,
              onClick: () => { input.value = text; input.focus(); },
            })))),
      }));
      return;
    }

    render(threadHost, card({
      flush: true,
      body: el('ol.mm-thread.mm-thread--chat',
        ...messages.map(message => messageNode(message))),
    }));
  }

  function messageNode(message) {
    const isUser = message.role === 'user';

    return el('li.mm-thread__item', { class: isUser ? '' : 'is-assistant' },
      isUser
        ? avatar(session.session().user?.fullName, { size: 'sm' })
        : el('span.mm-ai-avatar', icon('sparkle', { size: 'sm' })),

      el('div.mm-thread__body',
        el('div.mm-thread__head',
          el('span.mm-fw-medium', { text: isUser ? 'You' : 'Assistant' }),
          !isUser && message.groundedInYourData
            ? pill('From your records', 'success')
            : (!isUser ? pill('General guidance', 'neutral') : null),
          message.model ? el('span.mm-muted.mm-text-xs', { text: message.model }) : null,
          el('span.mm-muted.mm-text-xs', { text: fmt.relative(message.createdAt) })),

        ...String(message.content ?? '').split(/\n{2,}/).map(paragraph =>
          el('p.mm-thread__text', { text: paragraph })),

        message.citations?.length
          ? frag(
              el('p.mm-label.mm-mt-2', { text: 'Based on' }),
              el('ul.mm-attachments',
                ...message.citations.map(citation => el('li',
                  el('a.mm-attachment', { href: citationHref(citation) },
                    icon('link', { size: 'sm' }),
                    el('span', { text: citation.label ?? citation.title ?? citation.id }))))))
          : null,

        message.disclaimer
          ? el('p.mm-muted.mm-text-xs.mm-mt-2', { text: message.disclaimer })
          : null,

        message.error
          ? el('p.mm-c-danger.mm-text-sm', { text: message.error })
          : null));
  }

  // ---- The question box ---------------------------------------------------
  const input = el('textarea.mm-input.mm-textarea', {
    rows: '3',
    placeholder: ready
      ? 'Ask about a client, a period, or a rule…'
      : 'The assistant is not connected on this deployment.',
    'aria-label': 'Your question',
    disabled: !ready,
    onKeydown: (e) => {
      // Enter sends; Shift+Enter is a new line. Sending is the common case.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    },
  });

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question || !ready) return;

      // The question goes into the thread immediately; waiting for the round
      // trip to show what you just typed feels broken.
      messages = [...messages, {
        role: 'user', content: question, createdAt: new Date().toISOString(),
      }];
      paintThread();
      input.value = '';

      const pending = el('li.mm-thread__item.is-assistant',
        el('span.mm-ai-avatar', icon('sparkle', { size: 'sm' })),
        el('div.mm-thread__body',
          el('p.mm-muted.mm-text-sm', el('span.mm-spinner.mm-spinner--sm'), ' Thinking…')));
      threadHost.querySelector('.mm-thread')?.append(pending);

      try {
        const { data } = await api.post('/ai/ask', {
          question,
          conversationId: conversationId ?? undefined,
        });
        conversationId = data.conversationId;
        router.setQuery({ c: conversationId });
        messages = [...messages, {
          ...data.message,
          groundedInYourData: data.grounding?.groundedInYourData ?? data.message.groundedInYourData,
          citations: data.grounding?.citations ?? data.message.citations,
          disclaimer: data.message.disclaimer ?? data.grounding?.note,
        }];
        paintThread();
        loadHistory();
      } catch (err) {
        pending.remove();
        notifyError(err);
      }
    },
  },
    input,
    el('div.mm-row.mm-gap-3.mm-center.mm-mt-2',
      el('span.mm-muted.mm-text-xs', {
        text: 'Answers are generated. Check anything you rely on before you file it.',
      }),
      el('span.mm-grow'),
      el('button.mm-btn.mm-btn--primary', { type: 'submit', disabled: !ready, text: 'Ask' })));

  page.append(
    pageHead({
      title: 'Tax assistant',
      subtitle: 'GST and TDS questions, answered against your own records where it can.',
    }),

    ready
      ? null
      : banner({
          text: capability
            ? `${capability.provider} is not connected${capability.missingKeys?.length ? ` — ${capability.missingKeys.join(', ')} ${capability.missingKeys.length === 1 ? 'is' : 'are'} not set` : ''}. Nothing can be asked until it is.`
            : 'No language model is connected on this deployment.',
          tone: 'warning',
          icon: 'plug',
          action: session.can('integrations.manage')
            ? { label: 'Open integrations', href: '/settings/integrations' }
            : null,
        }),

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4', threadHost, card({ body: form })),
      sideHost));

  paintThread();
  await Promise.all([loadConversation(), loadHistory()]);
  return page;
}

function citationHref(citation) {
  const type = citation.type ?? citation.entityType;
  const id = citation.id ?? citation.entityId;
  if (!id) return '#';
  return {
    document: `/documents/${id}`,
    computation: `/tax/${id}`,
    report: `/reports/${id}`,
    client: `/clients/${id}`,
    invoice: `/billing/invoices/${id}`,
  }[type] ?? '#';
}

/** What each AI capability needs, and whether it has it. */
function capabilityCard(status) {
  return card({
    title: 'What is connected',
    subtitle: 'Each capability needs its own provider.',
    flush: true,
    body: el('ul.mm-list',
      ...(status.capabilities ?? []).map(capability => el('li.mm-list__row',
        el('span.mm-list__icon', { class: capability.configured ? 'mm-c-success' : 'mm-muted' },
          icon(capability.configured ? 'check-circle' : 'plug', { size: 'sm' })),
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: capability.name }),
          el('span.mm-muted.mm-text-xs', {
            text: capability.configured
              ? capability.provider
              : `${capability.provider} — needs ${(capability.missingKeys ?? []).join(', ')}`,
          })),
        capability.featureUnlocked
          ? (capability.configured ? pill('Ready', 'success') : pill('Needs keys', 'warning'))
          : pill('Not in plan', 'neutral')))),
  });
}
