/**
 * Sign in.
 *
 * Handles the three outcomes the API can return: signed in, a second factor is
 * needed, or the attempt was refused. A lockout is shown with the time it
 * lifts rather than a bare refusal, because "try again later" with no "when"
 * is what makes people call support.
 */

import { el, frag } from '../../core/dom.js';
import { api, setToken } from '../../core/api.js';
import * as session from '../../core/session.js';
import * as router from '../../core/router.js';
import { notify, notifyError, button } from '../../core/ui.js';
import { authLayout, field, formError, passwordInput } from './layout.js';

export default async function loginScreen({ query }) {
  const next = query.get('next');
  let busy = false;

  const errorHost = el('div');
  const emailInput = el('input.mm-input', {
    type: 'email', name: 'email', id: 'mm-email', required: true,
    autocomplete: 'username', placeholder: 'you@firm.example', autofocus: true,
  });
  const { box: passwordBox, input: passwordField } = passwordInput({
    name: 'password', id: 'mm-password',
    autocomplete: 'current-password', placeholder: 'Your password',
  });

  const submit = button('Sign in', { variant: 'primary', type: 'submit' });
  submit.classList.add('mm-btn--block');

  const form = el('form.mm-auth__form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      if (busy) return;

      const email = emailInput.value.trim();
      const password = passwordField.value;
      if (!email || !password) {
        errorHost.replaceChildren(formError('Enter your email address and password.'));
        return;
      }

      busy = true;
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      errorHost.replaceChildren();

      try {
        const { data } = await api.post('/auth/login', { email, password });

        // Two factors: the password was right, but the session is not usable
        // until the code is. The interim token only unlocks the verify step.
        if (data.twoFactorRequired) {
          setToken(data.token);
          router.go(`/verify-2fa${next ? `?next=${encodeURIComponent(next)}` : ''}`);
          return;
        }

        await session.signIn(data.token);
        const { enterApp } = await import('../../app.js');
        await enterApp();
        // The server names where this role belongs; the login reply's own
        // `landing` and the session agree because both come from the same
        // role table.
        router.go(next || data.landing || session.landingPath(), { replace: true });
      } catch (err) {
        errorHost.replaceChildren(formError(messageFor(err)));
        passwordField.value = '';
        passwordField.focus();
      } finally {
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    },
  },
    errorHost,
    field({ label: 'Email address', input: emailInput, id: 'mm-email' }),
    field({
      label: 'Password',
      input: passwordBox,
      id: 'mm-password',
      action: el('a.mm-link.mm-text-xs', { href: '/forgot-password', text: 'Forgot password?' }),
    }),
    submit,
    el('p.mm-auth__foot',
      'New to Meet Millions? ',
      el('a.mm-link', { href: '/register', text: 'Create an organisation' })));

  return authLayout({
    title: 'Sign in',
    subtitle: 'Your clients’ filings, documents and deadlines in one place.',
    form,
  });
}

/**
 * The message to show.
 *
 * A wrong password and an unknown email deliberately produce the same words —
 * distinguishing them turns the sign-in form into a way to discover which
 * email addresses have accounts.
 */
function messageFor(err) {
  if (err.code === 'account_locked') {
    const until = err.details?.lockedUntil;
    return until
      ? `Too many failed attempts. You can try again after ${new Date(until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.`
      : 'Too many failed attempts. Try again shortly, or reset your password.';
  }
  if (err.status === 429) {
    return 'Too many attempts from this device. Wait a minute and try again.';
  }
  if (err.code === 'ip_blocked') {
    return 'Your organisation only allows sign-in from approved networks, and this one is not on the list.';
  }
  if (err.status === 401 || err.code === 'invalid_credentials') {
    return 'That email address and password do not match an account.';
  }
  if (err.status === 403) return err.message;
  return err.message ?? 'Could not sign you in. Please try again.';
}
