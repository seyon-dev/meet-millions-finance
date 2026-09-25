/**
 * The platform entrance — the Super Admin's own door, linked from nowhere.
 *
 * Two states, decided by the server:
 *   unclaimed  — no platform owner exists yet, so the page is a one-time
 *                claim form; the first submission creates the owner and the
 *                form never appears again on this deployment.
 *   claimed    — an ordinary sign-in that sends portal: 'platform'. The
 *                server refuses organisation accounts here, and refuses the
 *                platform account at the public /login, so the two doors
 *                never blur.
 *
 * Unlisted is not secret: this path is readable in the application's own
 * JavaScript. The protection is the credentials, the role check every
 * platform route makes, and two-factor — never the URL.
 */

import { el } from '../../core/dom.js';
import { api, setToken } from '../../core/api.js';
import * as session from '../../core/session.js';
import * as router from '../../core/router.js';
import { button } from '../../core/ui.js';
import { authLayout, field, formError, formNotice, passwordInput, passwordMeter } from './layout.js';

export default async function platformLoginScreen({ query }) {
  let claimed = true;
  try {
    ({ data: { claimed } } = await api.get('/auth/platform-status'));
  } catch { /* if the status call fails, show the login form — it is the safe default */ }

  return claimed ? loginForm(query) : claimForm();
}

// ---------------------------------------------------------------------------

function loginForm(query) {
  const next = query?.get?.('next');
  let busy = false;

  const errorHost = el('div');
  const emailInput = el('input.mm-input', {
    type: 'email', name: 'email', id: 'mm-email', required: true,
    autocomplete: 'username', placeholder: 'owner@yourplatform.example', autofocus: true,
  });
  const { box: passwordBox, input: passwordField } = passwordInput({
    name: 'password', id: 'mm-password',
    autocomplete: 'current-password', placeholder: 'Your password',
  });

  const submit = button('Enter the platform', { variant: 'primary', type: 'submit' });
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
      busy = true; submit.disabled = true; submit.textContent = 'Signing in…';
      errorHost.replaceChildren();
      try {
        const { data } = await api.post('/auth/login', { email, password, portal: 'platform' });
        if (data.twoFactorRequired) {
          setToken(data.token);
          router.go(`/verify-2fa${next ? `?next=${encodeURIComponent(next)}` : ''}`);
          return;
        }
        await session.signIn(data.token);
        const { enterApp } = await import('../../app.js');
        await enterApp();
        router.go(next || data.landing || session.landingPath(), { replace: true });
      } catch (err) {
        errorHost.replaceChildren(formError(err.message ?? 'Could not sign you in.'));
        passwordField.value = '';
        passwordField.focus();
      } finally {
        busy = false; submit.disabled = false; submit.textContent = 'Enter the platform';
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
    submit);

  return authLayout({
    title: 'Platform Control',
    subtitle: 'The owner’s entrance to Meet Millions. Organisation accounts sign in on the normal page.',
    form,
  });
}

// ---------------------------------------------------------------------------

function claimForm() {
  let busy = false;

  const errorHost = el('div');
  const nameInput = el('input.mm-input', {
    type: 'text', name: 'fullName', id: 'mm-name', required: true,
    autocomplete: 'name', placeholder: 'Your name', autofocus: true,
  });
  const emailInput = el('input.mm-input', {
    type: 'email', name: 'email', id: 'mm-email', required: true,
    autocomplete: 'username', placeholder: 'owner@yourplatform.example',
  });
  const { box: passwordBox, input: passwordField } = passwordInput({
    name: 'password', id: 'mm-password',
    autocomplete: 'new-password', placeholder: 'At least 12 characters, mixed',
  });

  const submit = button('Claim the platform', { variant: 'primary', type: 'submit' });
  submit.classList.add('mm-btn--block');

  const form = el('form.mm-auth__form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      if (busy) return;
      const fullName = nameInput.value.trim();
      const email = emailInput.value.trim();
      const password = passwordField.value;
      if (!fullName || !email || !password) {
        errorHost.replaceChildren(formError('Fill in your name, email address and password.'));
        return;
      }
      busy = true; submit.disabled = true; submit.textContent = 'Creating the owner account…';
      errorHost.replaceChildren();
      try {
        const { data } = await api.post('/auth/platform-setup', { fullName, email, password });
        await session.signIn(data.token);
        const { enterApp } = await import('../../app.js');
        await enterApp();
        router.go(data.landing || '/admin/dashboard', { replace: true });
      } catch (err) {
        const fieldError = err.fields?.password ?? err.message ?? 'That did not work.';
        errorHost.replaceChildren(formError(fieldError));
      } finally {
        busy = false; submit.disabled = false; submit.textContent = 'Claim the platform';
      }
    },
  },
    formNotice(
      'This platform has no owner yet. The account created here becomes the Super Admin — '
      + 'this form appears exactly once, and this page becomes your private sign-in afterwards.',
      'warning'),
    errorHost,
    field({ label: 'Your name', input: nameInput, id: 'mm-name' }),
    field({ label: 'Email address', input: emailInput, id: 'mm-email' }),
    field({ label: 'Password', input: passwordBox, id: 'mm-password', below: passwordMeter(passwordField, { minLength: 12 }) }),
    submit,
    el('p.mm-auth__foot.mm-muted.mm-text-xs',
      'Turn on two-factor authentication immediately after — this account can reach every organisation.'));

  return authLayout({
    title: 'Claim the platform',
    subtitle: 'One-time setup of the Meet Millions owner account.',
    form,
  });
}
