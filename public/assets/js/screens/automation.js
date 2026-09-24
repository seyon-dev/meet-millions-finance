/**
 * Automation rules.
 *
 * "When this happens, do that." The rule builder is deliberately small — one
 * trigger, optional delay, a short list of actions — because an automation
 * engine nobody can read is an automation engine nobody trusts.
 *
 * Every rule can be previewed against real records before it is switched on,
 * so "who would this have fired for?" is answerable without firing it.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as session from '../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, emptyState, errorState, skeletonTable,
  notify, notifyError, confirm, modal, lockedState,
} from '../core/ui.js';
import { setBreadcrumbs } from '../layout/shell.js';

export default async function automationScreen() {
  setBreadcrumbs([{ label: 'Automation' }]);

  const page = el('div.mm-page');
  const listHost = el('div');

  let triggers = [];
  let actionTypes = [];

  async function load() {
    render(listHost, skeletonTable(5, 3));
    try {
      const { data, meta } = await api.get('/automation', { pageSize: 100 });
      triggers = meta.triggers ?? triggers;
      actionTypes = meta.actionTypes ?? actionTypes;
      render(listHost, rulesCard(data ?? [], load, () => ({ triggers, actionTypes })));
    } catch (err) {
      if (err.name === 'FeatureLocked') {
        render(page,
          pageHead({ title: 'Automation' }),
          lockedState({
            featureName: 'Automation',
            requiredAddOn: 'email_automation',
            message: 'Trigger reminders, follow-ups and status changes from what happens in the CRM.',
          }));
        return;
      }
      render(listHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Automation',
      subtitle: 'Rules that run themselves when something happens in the CRM.',
      actions: session.can('automation.manage')
        ? button('New rule', {
            variant: 'primary', icon: 'zap',
            onClick: () => openRule(null, () => ({ triggers, actionTypes }), load),
          })
        : null,
    }),
    listHost);

  await load();
  return page;
}

function rulesCard(rules, reload, context) {
  if (!rules.length) {
    return emptyState({
      title: 'No rules yet',
      message: 'A rule watches for one thing — a document uploaded, a filing due, an invoice overdue — and does something about it.',
      icon: 'zap',
    });
  }

  const active = rules.filter(r => r.isActive).length;
  const fired = rules.reduce((sum, r) => sum + (r.fireCount ?? 0), 0);

  return frag(
    el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Rules', value: fmt.number(rules.length), icon: 'zap' }),
      stat({ label: 'Active', value: fmt.number(active), icon: 'check-circle', tone: active ? 'success' : null }),
      stat({ label: 'Times fired', value: fmt.number(fired), icon: 'activity' }),
      stat({
        label: 'Last fired',
        value: rules.some(r => r.lastFiredAt)
          ? fmt.relative(rules.map(r => r.lastFiredAt).filter(Boolean).sort().reverse()[0])
          : 'Never',
        icon: 'clock',
      })),

    card({
      title: 'Rules',
      flush: true,
      className: 'mm-mt-4',
      body: el('ul.mm-list',
        ...rules.map(rule => el('li.mm-list__row',
          el('span.mm-list__icon', { class: rule.isActive ? 'mm-c-brand' : 'mm-muted' },
            icon('zap', { size: 'sm' })),

          el('div.mm-list__main',
            el('span.mm-fw-medium', { text: rule.name }),
            el('span.mm-muted.mm-text-xs', {
              text: [
                `When ${rule.triggerName.toLowerCase()}`,
                rule.delayMinutes ? `after ${fmt.minutes(rule.delayMinutes)}` : null,
                ...(rule.summary ?? []),
              ].filter(Boolean).join(' · '),
            }),
            rule.fireCount
              ? el('span.mm-muted.mm-text-xs', {
                  text: `Fired ${fmt.plural(rule.fireCount, 'time')}, last ${fmt.relative(rule.lastFiredAt)}`,
                })
              : el('span.mm-muted.mm-text-xs', { text: 'Has not fired yet' })),

          statusPill(rule.isActive ? 'active' : 'inactive'),

          session.can('automation.manage')
            ? el('div.mm-row.mm-gap-1',
                button('Preview', {
                  variant: 'ghost', size: 'sm',
                  onClick: () => preview(rule),
                }),
                button('Edit', {
                  size: 'xs', variant: 'ghost',
                  // The editor always supported editing — modal title, PATCH
                  // path, prefilled fields — but nothing on the screen called
                  // it with an existing rule, so the only way to change one
                  // was to delete it and start again.
                  onClick: () => openRule(rule, context, reload),
                }),
                button(rule.isActive ? 'Pause' : 'Resume', {
                  variant: 'ghost', size: 'sm',
                  onClick: () => toggle(rule, reload),
                }),
                button('Delete', {
                  variant: 'ghost', size: 'sm',
                  onClick: () => remove(rule, reload),
                }))
            : null))),
    }));
}

/**
 * The rule builder.
 *
 * Actions are added one at a time, each with only the fields its own type
 * needs — a single form with every field for every action type would be a form
 * nobody could fill in correctly.
 */
async function openRule(existing, context, reload) {
  const { triggers, actionTypes } = context();

  const payload = await modal({
    title: existing ? `Edit ${existing.name}` : 'New rule',
    description: 'One trigger, an optional wait, and what should happen.',
    size: 'lg',
    body: ({ close }) => {
      const name = el('input.mm-input', { value: existing?.name ?? '', placeholder: 'Chase an overdue invoice' });
      const description = el('textarea.mm-input.mm-textarea', { rows: '2', value: existing?.description ?? '' });

      const trigger = el('select.mm-select',
        ...groupTriggers(triggers).flatMap(([category, items]) => [
          el('optgroup', { label: category },
            ...items.map(t => el('option', {
              value: t.key, selected: t.key === existing?.triggerKey, text: t.name,
            }))),
        ]));

      const delay = el('input.mm-input', {
        type: 'number', min: '0', max: '20160',
        value: String(existing?.delayMinutes ?? 0),
      });

      let actions = existing?.actions?.length ? [...existing.actions] : [{ type: 'notify' }];
      const actionsHost = el('div.mm-stack.mm-gap-3');
      const errorHost = el('div');

      const paintActions = () => {
        render(actionsHost, ...actions.map((action, index) => {
          const definition = actionTypes.find(a => a.key === action.type) ?? actionTypes[0];

          const typeSelect = el('select.mm-select', {
            onChange: (e) => { actions[index] = { type: e.target.value }; paintActions(); },
          },
            ...actionTypes.map(a => el('option', {
              value: a.key, selected: a.key === action.type, text: a.name,
            })));

          const fields = (definition?.fields ?? []).map(field => el('div.mm-field',
            el('label.mm-field__label', { text: fmt.label(field) }),
            el('input.mm-input', {
              value: action[field] ?? '',
              placeholder: placeholderFor(field),
              onInput: (e) => { actions[index][field] = e.target.value; },
            })));

          return el('div.mm-card.mm-card--inset',
            el('div.mm-card__body',
              el('div.mm-row.mm-gap-2.mm-center',
                typeSelect,
                el('span.mm-grow'),
                actions.length > 1
                  ? el('button.mm-btn.mm-btn--ghost.mm-btn--sm', {
                      type: 'button', text: 'Remove',
                      onClick: () => { actions = actions.filter((_, i) => i !== index); paintActions(); },
                    })
                  : null),
              el('div.mm-grid.mm-grid-2.mm-gap-3.mm-mt-3', ...fields)));
        }));
      };

      paintActions();

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Give the rule a name.' }));
            return;
          }
          const usable = actions.filter(a => a.type);
          if (!usable.length) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'A rule needs at least one action.' }));
            return;
          }
          close({
            name: name.value.trim(),
            description: description.value.trim() || undefined,
            triggerKey: trigger.value,
            delayMinutes: Number(delay.value) || 0,
            actions: usable,
            isActive: existing ? existing.isActive : true,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), name),
        el('div.mm-field', el('label.mm-field__label', { text: 'What it is for' }), description),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'When' }), trigger),
          el('div.mm-field',
            el('label.mm-field__label', { text: 'Wait (minutes)' }), delay,
            el('p.mm-field__hint', { text: 'Zero fires immediately. 1440 is a day.' }))),

        el('h3.mm-label.mm-mt-4', { text: 'Then' }),
        actionsHost,
        el('div.mm-row.mm-mt-2',
          el('button.mm-btn.mm-btn--ghost.mm-btn--sm', {
            type: 'button', text: 'Add another action',
            onClick: () => { actions.push({ type: 'notify' }); paintActions(); },
          })),

        el('div.mm-row.mm-end.mm-gap-2.mm-mt-5',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: existing ? 'Save' : 'Create the rule' })));
    },
  });
  if (!payload) return;

  try {
    if (existing) await api.patch(`/automation/${existing.id}`, payload);
    else await api.post('/automation', payload);
    notify.success(existing ? 'Saved.' : 'Rule created.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

function groupTriggers(triggers) {
  const map = new Map();
  for (const trigger of triggers) {
    const key = trigger.category ?? 'Other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(trigger);
  }
  return [...map.entries()];
}

function placeholderFor(field) {
  return {
    title: 'Chase the missing statement',
    subject: 'We still need your bank statement',
    body: 'Your September filing is waiting on one document.',
    dueInDays: '2',
    tag: 'chase',
    status: 'awaiting_client',
    channels: 'email,whatsapp',
    recipient: 'assigned_executive',
    userId: 'Leave blank to keep the current assignee',
    triggerKey: 'document.uploaded',
    assignTo: 'assigned_executive',
  }[field] ?? '';
}

/** What the rule would have done, without doing it. */
async function preview(rule) {
  try {
    const { data } = await api.post(`/automation/${rule.id}/preview`, {});
    await modal({
      title: `Preview — ${rule.name}`,
      description: 'What this rule would do, against the records as they stand now. Nothing is sent, changed or created.',
      body: ({ close }) => frag(
        el('p.mm-prose', {
          text: data.wouldMatch
            ? `It would fire for ${fmt.plural(data.wouldMatch, 'record')}.`
            : 'Nothing currently matches this rule, so it would not fire.',
        }),

        (data.sample ?? []).length
          ? frag(
              el('h3.mm-label.mm-mt-4', { text: 'For example' }),
              el('ul.mm-list',
                ...data.sample.map(match => el('li.mm-list__row',
                  el('div.mm-list__main',
                    el('span.mm-fw-medium', {
                      text: match.label ?? match.title ?? match.display_name ?? match.id,
                    }),
                    match.detail || match.client_name
                      ? el('span.mm-muted.mm-text-xs', { text: match.detail ?? match.client_name })
                      : null)))))
          : null,

        (data.wouldDo ?? []).length
          ? frag(
              el('h3.mm-label.mm-mt-4', { text: 'And it would' }),
              el('ul.mm-ticklist',
                ...data.wouldDo.map(action => el('li',
                  icon('arrow-right', { size: 'sm' }),
                  el('span', { text: String(action) })))))
          : null,

        el('div.mm-row.mm-end.mm-mt-4',
          el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Close', onClick: () => close(null) }))),
    });
  } catch (err) {
    notifyError(err);
  }
}

async function toggle(rule, reload) {
  try {
    await api.patch(`/automation/${rule.id}`, { isActive: !rule.isActive });
    notify.success(rule.isActive ? 'Paused.' : 'Running.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function remove(rule, reload) {
  const answer = await confirm({
    title: `Delete “${rule.name}”?`,
    message: 'It stops firing immediately. Anything it has already done stays.',
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!answer) return;

  try {
    await api.delete(`/automation/${rule.id}`);
    notify.success('Deleted.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
