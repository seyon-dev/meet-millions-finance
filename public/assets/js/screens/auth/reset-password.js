/**
 * Set a new password from an emailed link.
 *
 * The token arrives in the query string, is used once, and is never shown in
 * the interface — a reset token on screen is a reset token in a screenshot.
 */

import { el, render } from '../../core/dom.js';
import { api } from '../../core/api.js';
import * as router from '../../core/router.js';
import { button, notify } from '../../core/ui.js';
import { authLayout, field, formError, formNotice, passwordMeter } from './layout.js';

export default async function resetPasswordScreen({ query }) {
  const token = query.get('token');
  let busy = false;

  if (!token) {
    return authLayout({
      title: 'That link is incomplete',
      subtitle: 'The reset link is missing its token.',
      form: el('div',
        formError('Open the link from your email again, or request a new one.'),
        el('p.mm-auth__foot',
          el('a.mm-link', { href: '/forgot-password', text: 'Request a new link' }))),
    });
  }

  const errorHost = el('div');
  const formHost = el('div');

  const password = el('input.mm-input', {
    type: 'password', id: 'mm-password', required: true,
    autocomplete: 'new-password', autofocus: true,
  });
  const confirm = el('input.mm-input', {
    type: 'password', id: 'mm-confirm', required: true, autocomplete: 'new-password',
  });

  const submit = button('Set new password', { variant: 'primary', type: 'submit' });
  submit.classList.add('mm-btn--block');

  const form = el('form.mm-auth__form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      if (busy) return;

      if (password.value !== confirm.value) {
        errorHost.replaceChildren(formError('The two passwords do not match.'));
        confirm.focus();
        return;
      }
      if (password.value.length < 10) {
        errorHost.replaceChildren(formError('Your password needs at least ten characters.'));
        return;
      }

      busy = true;
      submit.disabled = true;
      submit.textContent = 'Saving…';

      try {
        await api.post('/auth/reset-password', { token, password: password.value });
        render(formHost,
          formNotice('Your password has been changed. Every other session has been signed out.', 'success'),
          el('a.mm-btn.mm-btn--primary.mm-btn--block.mm-mt-3', { href: '/login', text: 'Sign in' }));
      } catch (err) {
        errorHost.replaceChildren(formError(
          err.status === 404 || err.code === 'invalid_token'
            ? 'That link has already been used, or has expired. Request a new one.'
            : err.message));
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Set new password';
      }
    },
  },
    errorHost,
    field({
      label: 'New password', id: 'mm-password', input: password, required: true,
      below: passwordMeter(password),
    }),
    field({ label: 'Confirm new password', id: 'mm-confirm', input: confirm, required: true }),
    submit,
    el('p.mm-auth__foot', el('a.mm-link', { href: '/login', text: 'Back to sign in' })));

  render(formHost, form);

  return authLayout({
    title: 'Choose a new password',
    subtitle: 'Setting it here signs out every other session on your account.',
    form: formHost,
  });
}
