/**
 * Change your password.
 *
 * The organisation's own rules are fetched and shown as a live checklist, so
 * somebody typing a password knows why it is being refused before they submit
 * it. A forced change — after an administrator reset — says so and offers no
 * way past.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as session from '../../core/session.js';
import * as router from '../../core/router.js';
import {
  pageHead, card, button, notify, notifyError, banner, errorState,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function passwordScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Password' }]);

  const page = el('div.mm-page');
  const user = session.session().user ?? {};
  const forced = !!user.mustChangePassword;

  // The rules come from the organisation's own policy where the caller may
  // read it; otherwise the conservative defaults are shown.
  let policy = { password_min_length: 10, password_require_mixed: 1 };
  try {
    const { data } = await api.get('/settings/security');
    policy = data.policy ?? data.defaults ?? policy;
  } catch {
    // Reading the policy is an administrator's right; not having it is fine.
  }

  const current = el('input.mm-input', {
    type: 'password', autocomplete: 'current-password', id: 'mm-current',
  });
  const next = el('input.mm-input', {
    type: 'password', autocomplete: 'new-password', id: 'mm-new',
  });
  const confirmInput = el('input.mm-input', {
    type: 'password', autocomplete: 'new-password', id: 'mm-confirm',
  });

  const rulesHost = el('ul.mm-checklist.mm-mt-2');
  const errorHost = el('div');

  const rules = [
    {
      label: `At least ${policy.password_min_length ?? 10} characters`,
      test: v => v.length >= (policy.password_min_length ?? 10),
    },
    ...(policy.password_require_mixed
      ? [
          { label: 'An upper-case letter', test: v => /[A-Z]/.test(v) },
          { label: 'A lower-case letter', test: v => /[a-z]/.test(v) },
          { label: 'A number', test: v => /\d/.test(v) },
        ]
      : []),
    { label: 'Different from your current password', test: v => v && v !== current.value },
  ];

  const paintRules = () => {
    const value = next.value;
    render(rulesHost, ...rules.map(rule => el('li.mm-checklist__item',
      el('span.mm-checklist__icon', { class: rule.test(value) ? 'mm-c-success' : 'mm-muted' },
        icon(rule.test(value) ? 'check' : 'minus', { size: 'sm' })),
      el('span', { text: rule.label }))));
  };

  next.addEventListener('input', paintRules);
  current.addEventListener('input', paintRules);
  paintRules();

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      errorHost.replaceChildren();

      if (next.value !== confirmInput.value) {
        errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'The two new passwords do not match.' }));
        confirmInput.focus();
        return;
      }
      const failed = rules.find(rule => !rule.test(next.value));
      if (failed) {
        errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: `Still needed: ${failed.label.toLowerCase()}.` }));
        next.focus();
        return;
      }

      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      submitButton.textContent = 'Changing…';

      try {
        await api.post('/auth/change-password', {
          currentPassword: current.value,
          newPassword: next.value,
        });
        notify.success('Password changed. Your other sessions have been signed out.');
        // The flag is cleared server-side; re-reading it is what releases the
        // navigation guard that was holding this person on this screen.
        await session.load();
        router.go(session.landingPath(), { replace: true });
      } catch (err) {
        errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: err.message }));
        notifyError(err);
        submitButton.disabled = false;
        submitButton.textContent = 'Change password';
      }
    },
  },
    errorHost,
    el('div.mm-field',
      el('label.mm-field__label', { for: 'mm-current', text: 'Your current password' }), current),
    el('div.mm-field',
      el('label.mm-field__label', { for: 'mm-new', text: 'New password' }), next, rulesHost),
    el('div.mm-field',
      el('label.mm-field__label', { for: 'mm-confirm', text: 'New password again' }), confirmInput),
    el('div.mm-row.mm-end.mm-mt-4',
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Change password' })));

  page.append(
    pageHead({
      title: 'Password',
      subtitle: forced ? null : 'Changing it signs out every other session of yours.',
    }),

    forced
      ? banner({
          text: 'Your password was reset by an administrator. Nothing else opens until you choose a new one.',
          tone: 'warning',
          icon: 'key',
        })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      card({ title: 'Change your password', body: form }),
      card({
        title: 'Why this matters',
        body: el('ul.mm-ticklist',
          el('li', icon('shield', { size: 'sm' }),
            el('span', { text: 'Your password is stored only as a slow one-way hash. Nobody here can read it.' })),
          el('li', icon('logout', { size: 'sm' }),
            el('span', { text: 'Changing it ends every other session, on every device.' })),
          el('li', icon('key', { size: 'sm' }),
            el('span', { text: 'A second factor protects the account even if the password is guessed.' })),
          el('li', icon('scroll-text', { size: 'sm' }),
            el('span', { text: 'The change is recorded in the audit trail, without the password itself.' }))),
      })));

  return page;
}
