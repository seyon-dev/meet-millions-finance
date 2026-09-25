/**
 * Your profile, and — for an administrator — the organisation's own details.
 *
 * Two forms on one screen because they are asked for together: "my details"
 * and "our details" are both answered from here, and the second only appears
 * for somebody who may change it.
 */

import { el, frag, render } from '../../core/dom.js';
import { api } from '../../core/api.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, button, avatar, notify, notifyError,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function profileScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Your profile' }]);

  const page = el('div.mm-page');
  const user = session.session().user ?? {};

  page.append(
    pageHead({
      title: 'Your profile',
      subtitle: user.email,
    }),
    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        personalCard(user),
        emailCard(user)),
      appearanceCard()));

  return page;
}

function personalCard(user) {
  const fullName = el('input.mm-input', { value: user.fullName ?? '' });
  const phone = el('input.mm-input', { type: 'tel', value: user.phone ?? '' });
  const jobTitle = el('input.mm-input', { value: user.jobTitle ?? '' });
  const locale = el('select.mm-select',
    ...['en-IN', 'en-GB', 'hi-IN'].map(l => el('option', { value: l, selected: l === user.locale, text: l })));
  const timezone = el('select.mm-select',
    ...['Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'UTC'].map(t => el('option', {
      value: t, selected: t === user.timezone, text: t,
    })));

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      try {
        await api.patch('/auth/profile', {
          fullName: fullName.value.trim(),
          phone: phone.value.trim() || undefined,
          jobTitle: jobTitle.value.trim() || undefined,
          locale: locale.value,
          timezone: timezone.value,
        });
        // The shell shows the name and initials, so the session is re-read.
        await session.load();
        notify.success('Saved.');
      } catch (err) {
        notifyError(err);
      } finally {
        submitButton.disabled = false;
      }
    },
  },
    el('div.mm-row.mm-gap-3.mm-center.mm-mb-4',
      avatar(user.fullName, { size: 'lg' }),
      el('div',
        el('p.mm-fw-medium', { text: user.fullName ?? '' }),
        el('p.mm-muted.mm-text-sm', { text: user.email ?? '' }))),

    el('div.mm-field', el('label.mm-field__label', { text: 'Your name' }), fullName),
    el('div.mm-grid.mm-grid-2.mm-gap-3',
      el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), phone),
      el('div.mm-field', el('label.mm-field__label', { text: 'Job title' }), jobTitle)),
    el('div.mm-grid.mm-grid-2.mm-gap-3',
      el('div.mm-field', el('label.mm-field__label', { text: 'Language' }), locale),
      el('div.mm-field', el('label.mm-field__label', { text: 'Timezone' }), timezone)),
    el('div.mm-row.mm-end.mm-mt-4',
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));

  return card({ title: 'About you', body: form });
}

/**
 * The sign-in email. Changing it re-confirms the password, because an open
 * laptop must never be enough to move the account to somebody else's address.
 */
function emailCard(user) {
  const email = el('input.mm-input', { type: 'email', value: user.email ?? '', autocomplete: 'email' });
  const password = el('input.mm-input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your current password' });
  const errorHost = el('div');

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      errorHost.replaceChildren();
      const next = email.value.trim();
      if (!next || next === user.email) {
        errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Enter a different email address.' }));
        return;
      }
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      try {
        await api.patch('/auth/profile', { email: next, currentPassword: password.value });
        password.value = '';
        await session.load();
        notify.success('Your sign-in email is now ' + next + '.');
      } catch (err) {
        notifyError(err);
      } finally {
        submitButton.disabled = false;
      }
    },
  },
    errorHost,
    el('div.mm-field', el('label.mm-field__label', { text: 'Sign-in email' }), email),
    el('div.mm-field',
      el('label.mm-field__label', { text: 'Confirm with your password' }), password,
      el('p.mm-field__hint', { text: 'You will sign in with the new address from now on.' })),
    el('div.mm-row.mm-end.mm-mt-2',
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Change email' })));

  return card({ title: 'Sign-in email', body: form });
}

/** Theme. Stored per browser rather than per account, deliberately. */
function appearanceCard() {
  const current = document.documentElement.getAttribute('data-theme') ?? 'system';

  const option = (value, label, description) => el('label.mm-switch', {
    class: 'mm-switch--radio',
  },
    el('input.mm-radio', {
      type: 'radio',
      name: 'mm-theme',
      checked: current === value,
      onChange: () => {
        session.setTheme(value);
        notify.success(`Theme: ${value === 'system' ? 'matching your system' : value}.`, { timeout: 1800 });
      },
    }),
    el('span.mm-switch__text',
      el('span', { text: label }),
      el('span.mm-muted.mm-text-xs.mm-block', { text: description })));

  return card({
    title: 'Appearance',
    subtitle: 'Kept in this browser, not on your account.',
    body: el('div.mm-stack.mm-gap-2',
      option('dark', 'Dark', 'The default. Built for long sessions on a screen.'),
      option('light', 'Light', 'For bright rooms and printing.'),
      option('system', 'Match my system', 'Follows your operating system, and changes with it.')),
  });
}
