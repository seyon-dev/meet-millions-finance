/**
 * Notifications.
 *
 * A grid of triggers against channels. Channels that cannot actually deliver —
 * because the plan does not include them, or because the provider has no
 * credentials — are shown disabled with the reason, rather than offering a
 * switch that turns on nothing.
 *
 * Mandatory notifications are shown locked on: a password reset that somebody
 * could switch off is a security problem, not a preference.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, button, pill, emptyState, errorState, skeletonTable,
  notify, notifyError, modal, banner,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function notificationSettingsScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Notifications' }]);

  const page = el('div.mm-page');
  const bodyHost = el('div');

  async function load() {
    render(bodyHost, skeletonTable(8, 5));
    try {
      const { data } = await api.get('/notifications/preferences');
      render(bodyHost, ...build(data, load));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Notifications',
      subtitle: 'What this tells you about, and how it reaches you.',
      actions: session.can('settings.manage')
        ? button('Templates', { variant: 'ghost', icon: 'mail', onClick: () => openTemplates() })
        : null,
    }),
    bodyHost);

  await load();
  return page;
}

function build(data, reload) {
  const channels = data.channels ?? [];
  const triggers = data.triggers ?? [];
  const usable = channels.filter(c => c.available);

  // Changes are collected and sent together: one request rather than one per
  // checkbox, so a half-saved grid is not possible.
  const pending = new Map();

  const saveButton = button('Save', { variant: 'primary', icon: 'check' });
  saveButton.disabled = true;

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const { data: result } = await api.put('/notifications/preferences', {
        preferences: [...pending.values()],
      });
      if (result?.rejected?.length) {
        notify.warning(`${result.rejected.length} could not be changed.`, { title: 'Partly saved' });
      }
      notify.success(`${fmt.plural(result?.applied?.length ?? pending.size, 'notification')} updated.`);
      pending.clear();
      await reload();
    } catch (err) {
      notifyError(err);
      saveButton.disabled = false;
      saveButton.textContent = 'Save';
    }
  });

  const groups = new Map();
  for (const trigger of triggers) {
    const key = trigger.category ?? 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trigger);
  }

  return [
    channels.some(c => !c.available)
      ? banner({
          text: `${channels.filter(c => !c.available).map(c => c.name).join(', ')} cannot deliver anything yet. ${channels.find(c => !c.available)?.unavailableReason ?? ''}`,
          tone: 'info',
          icon: 'plug',
          action: session.can('integrations.manage')
            ? { label: 'Open integrations', href: '/settings/integrations' }
            : null,
        })
      : null,

    card({
      title: 'Channels',
      flush: true,
      body: el('ul.mm-list',
        ...channels.map(channel => el('li.mm-list__row',
          el('span.mm-list__icon', { class: channel.available ? 'mm-c-success' : 'mm-muted' },
            icon(channel.icon ?? 'bell', { size: 'sm' })),
          el('div.mm-list__main',
            el('span.mm-fw-medium', { text: channel.name }),
            el('span.mm-muted.mm-text-xs', {
              text: channel.available
                ? `Through ${channel.providerName ?? 'this deployment'}`
                : channel.unavailableReason ?? 'Not available',
            })),
          channel.available
            ? frag(
                pill('Ready', 'success'),
                session.can('settings.manage')
                  ? button('Send a test', {
                      variant: 'ghost', size: 'sm',
                      onClick: () => sendTest(channel),
                    })
                  : null)
            : (channel.featureUnlocked ? pill('Needs keys', 'warning') : pill('Not in plan', 'neutral'))))),
    }),

    card({
      title: 'What you are told about',
      subtitle: `${fmt.plural(triggers.length, 'notification')} across ${fmt.plural(groups.size, 'area')}`,
      actions: saveButton,
      flush: true,
      body: usable.length
        ? el('div.mm-table-wrap',
            el('table.mm-table.mm-table--compact.mm-prefs',
              el('thead',
                el('tr',
                  el('th', { text: 'Notification' }),
                  ...usable.map(channel => el('th.mm-align-center', { text: channel.name })))),
              el('tbody',
                ...[...groups.entries()].flatMap(([category, items]) => [
                  el('tr.mm-prefs__group',
                    el('td', { colspan: String(usable.length + 1), text: category })),
                  ...items.map(trigger => el('tr',
                    el('td',
                      el('div.mm-stack',
                        el('span.mm-fw-medium', { text: trigger.name }),
                        el('span.mm-muted.mm-text-xs', {
                          text: [
                            `To the ${fmt.label(trigger.audience ?? 'user').toLowerCase()}`,
                            trigger.mandatory ? 'always sent' : null,
                            trigger.customised ? 'customised' : null,
                          ].filter(Boolean).join(' · '),
                        }))),
                    ...usable.map(channel => el('td.mm-align-center',
                      cell(trigger, channel, pending, saveButton))))),
                ]))))
        : emptyState({
            title: 'No channel can deliver anything yet',
            message: 'Connect an email, SMS or WhatsApp provider and these preferences become useful.',
            icon: 'bell',
            inline: true,
          }),
    }),
  ].filter(Boolean);
}

function cell(trigger, channel, pending, saveButton) {
  const enabled = trigger.channels?.[channel.key];
  const defaultOn = (trigger.defaultChannels ?? []).includes(channel.key);
  const checked = enabled === undefined ? defaultOn : !!enabled;

  if (trigger.mandatory) {
    return icon('lock', {
      size: 'sm',
      className: 'mm-muted',
      title: 'Always sent — this one cannot be switched off.',
    });
  }

  return el('input.mm-checkbox', {
    type: 'checkbox',
    checked,
    'aria-label': `${trigger.name} by ${channel.name}`,
    onChange: (e) => {
      const entry = pending.get(trigger.key) ?? { triggerKey: trigger.key, channels: {} };
      entry.channels[channel.key] = e.target.checked;
      pending.set(trigger.key, entry);
      saveButton.disabled = pending.size === 0;
    },
  });
}

async function sendTest(channel) {
  try {
    const { data } = await api.post('/notifications/test', { channel: channel.key });
    if (data.delivered) {
      notify.success(`A test went out through ${channel.name}.`);
    } else {
      const failure = (data.deliveries ?? []).find(d => d.error);
      notify.warning(failure?.error ?? `${channel.name} accepted nothing.`, {
        title: 'Not delivered',
      });
    }
  } catch (err) {
    notifyError(err);
  }
}

/**
 * The message templates.
 *
 * Each one can be edited or reset to the default it came with; the variables
 * it may use are listed, because a template referring to a variable that does
 * not exist renders an empty gap in somebody's email.
 */
async function openTemplates() {
  let templates;
  try {
    ({ data: { templates } } = await api.get('/notifications/templates'));
  } catch (err) {
    notifyError(err);
    return;
  }

  await modal({
    title: 'Message templates',
    description: 'What each notification actually says.',
    size: 'lg',
    body: ({ close }) => frag(
      el('ul.mm-list',
        ...(templates ?? []).map(template => el('li.mm-list__row', {
          onClick: () => { close(null); editTemplate(template); },
        },
          el('span.mm-list__icon.mm-muted', icon(iconFor(template.channel), { size: 'sm' })),
          el('div.mm-list__main',
            el('span.mm-fw-medium', { text: template.triggerName }),
            el('span.mm-muted.mm-text-xs', {
              text: [fmt.label(template.channel), template.subject].filter(Boolean).join(' · '),
            })),
          template.isCustomised ? pill('Edited', 'info') : pill('Default', 'neutral')))),
      el('div.mm-row.mm-end.mm-mt-4',
        el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Close', onClick: () => close(null) }))),
  });
}

function iconFor(channel) {
  return { email: 'mail', sms: 'smartphone', whatsapp: 'message-circle', push: 'bell', in_app: 'bell' }[channel] ?? 'mail';
}

async function editTemplate(template) {
  const result = await modal({
    title: template.triggerName,
    description: `${fmt.label(template.channel)} · ${template.triggerKey}`,
    size: 'lg',
    body: ({ close }) => {
      const subject = el('input.mm-input', { value: template.subject ?? '' });
      const body = el('textarea.mm-input.mm-textarea', { rows: '8', value: template.body ?? '' });

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({ action: 'save', subject: subject.value.trim(), body: body.value });
        },
      },
        template.channel === 'email'
          ? el('div.mm-field', el('label.mm-field__label', { text: 'Subject' }), subject)
          : null,
        el('div.mm-field', el('label.mm-field__label', { text: 'Message' }), body),

        (template.variables ?? []).length
          ? frag(
              el('h3.mm-label.mm-mt-3', { text: 'Variables you can use' }),
              el('div.mm-row.mm-gap-1.mm-wrap',
                ...template.variables.map(variable => el('button.mm-chip', {
                  type: 'button',
                  text: `{{${variable}}}`,
                  onClick: () => {
                    // Inserted where the cursor is, which is where somebody
                    // clicking a variable expects it to land.
                    const start = body.selectionStart ?? body.value.length;
                    body.value = `${body.value.slice(0, start)}{{${variable}}}${body.value.slice(body.selectionEnd ?? start)}`;
                    body.focus();
                  },
                }))))
          : null,

        el('div.mm-row.mm-gap-2.mm-mt-4',
          template.isCustomised
            ? el('button.mm-btn.mm-btn--ghost', {
                type: 'button', text: 'Reset to the default', onClick: () => close({ action: 'reset' }),
              })
            : null,
          el('span.mm-grow'),
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!result) return;

  try {
    await api.put(`/notifications/templates/${template.triggerKey}/${template.channel}`,
      result.action === 'reset'
        ? { reset: true }
        : { subject: result.subject || undefined, body: result.body });
    notify.success(result.action === 'reset' ? 'Reset to the default.' : 'Template saved.');
  } catch (err) {
    notifyError(err);
  }
}
