/**
 * Request a password reset.
 *
 * The response is deliberately the same whether the address has an account or
 * not. Telling a stranger which addresses exist here is a gift to anybody
 * working through a list of them.
 */

import { el, render } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { button } from '../../core/ui.js';
import { authLayout, field, formError, formNotice } from './layout.js';

export default async function forgotPasswordScreen() {
  let busy = false;
  const errorHost = el('div');
  const formHost = el('div');

  const emailInput = el('input.mm-input', {
    type: 'email', id: 'mm-email', required: true,
    autocomplete: 'username', placeholder: 'you@firm.example', autofocus: true,
  });

  const submit = button('Send reset link', { variant: 'primary', type: 'submit' });
  submit.classList.add('mm-btn--block');

  const form = el('form.mm-auth__form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      if (busy) return;

      const email = emailInput.value.trim();
      if (!email) {
        errorHost.replaceChildren(formError('Enter the email address on your account.'));
        return;
      }

      busy = true;
      submit.disabled = true;
      submit.textContent = 'Sending…';

      try {
        const { data } = await api.post('/auth/forgot-password', { email });
        render(formHost,
          formNotice(
            `If ${email} has an account, a reset link is on its way. It is valid for one hour.`,
            'success'),
          // When email is not configured on the deployment, say so rather than
          // leaving somebody waiting for a message that will never arrive.
          data?.delivery?.sent === false
            ? el('p.mm-muted.mm-text-sm.mm-mt-3', {
                text: 'Email is not configured on this deployment, so no message was sent. Ask your administrator to reset it for you.',
              })
            : null,
          el('p.mm-auth__foot', el('a.mm-link', { href: '/login', text: 'Back to sign in' })));
      } catch (err) {
        errorHost.replaceChildren(formError(
          err.status === 429
            ? 'Too many requests. Wait a minute and try again.'
            : err.message));
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Send reset link';
      }
    },
  },
    errorHost,
    field({
      label: 'Email address', id: 'mm-email', input: emailInput, required: true,
      hint: 'We will send a link that lets you set a new password.',
    }),
    submit,
    el('p.mm-auth__foot',
      el('a.mm-link', { href: '/login', text: 'Back to sign in' })));

  render(formHost, form);

  return authLayout({
    title: 'Reset your password',
    subtitle: 'We will email you a link to set a new one.',
    form: formHost,
  });
}
