/**
 * Two-factor verification.
 *
 * Six separate inputs rather than one field: pasting a code from an
 * authenticator app fills them all, typing advances between them, and
 * backspace steps back — which is what people expect from this pattern and
 * what a single input gets wrong on mobile keyboards.
 *
 * A backup code is offered in the same place, because somebody who has lost
 * their phone is exactly the person who cannot find a separate link for it.
 */

import { el, render } from '../../core/dom.js';
import { api, setToken } from '../../core/api.js';
import * as session from '../../core/session.js';
import * as router from '../../core/router.js';
import { button } from '../../core/ui.js';
import { authLayout, field, formError } from './layout.js';

export default async function verifyTwoFactorScreen({ query }) {
  const next = query.get('next');
  let busy = false;
  let usingBackup = false;

  const errorHost = el('div');
  const inputHost = el('div');

  const submit = button('Verify', { variant: 'primary', type: 'submit' });
  submit.classList.add('mm-btn--block');

  const backupInput = el('input.mm-input.mm-mono', {
    id: 'mm-backup', placeholder: 'xxxx-xxxx', autocomplete: 'one-time-code',
  });

  const digits = Array.from({ length: 6 }, (_, i) => el('input', {
    type: 'text',
    inputmode: 'numeric',
    maxlength: '1',
    'aria-label': `Digit ${i + 1} of 6`,
    autocomplete: i === 0 ? 'one-time-code' : 'off',
    onInput: (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 1);
      if (e.target.value && i < 5) digits[i + 1].focus();
      if (digits.every(d => d.value)) form.requestSubmit();
    },
    onKeydown: (e) => {
      if (e.key === 'Backspace' && !e.target.value && i > 0) digits[i - 1].focus();
      if (e.key === 'ArrowLeft' && i > 0) digits[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 5) digits[i + 1].focus();
    },
    onPaste: (e) => {
      // One paste fills the row. Without this, pasting a six-digit code puts
      // all six characters in the first box and the form silently fails.
      const text = (e.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
      if (!text) return;
      e.preventDefault();
      text.split('').forEach((char, index) => { digits[index].value = char; });
      digits[Math.min(text.length, 5)].focus();
      if (text.length === 6) form.requestSubmit();
    },
  }));

  const form = el('form.mm-auth__form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      if (busy) return;

      const code = usingBackup
        ? backupInput.value.trim()
        : digits.map(d => d.value).join('');

      if (!usingBackup && code.length !== 6) {
        errorHost.replaceChildren(formError('Enter all six digits.'));
        return;
      }
      if (usingBackup && !code) {
        errorHost.replaceChildren(formError('Enter one of your backup codes.'));
        return;
      }

      busy = true;
      submit.disabled = true;
      submit.textContent = 'Verifying…';
      errorHost.replaceChildren();

      try {
        const { data } = await api.post('/auth/2fa/verify',
          usingBackup ? { backupCode: code } : { code });

        await session.signIn(data.token ?? null);
        const { enterApp } = await import('../../app.js');
        await enterApp();
        router.go(next || data.landing || session.landingPath(), { replace: true });
      } catch (err) {
        errorHost.replaceChildren(formError(
          err.status === 401 || err.code === 'invalid_code'
            ? (usingBackup
                ? 'That backup code is not valid, or has already been used.'
                : 'That code is not right. Codes change every thirty seconds — check the current one.')
            : err.message));

        digits.forEach(d => { d.value = ''; });
        (usingBackup ? backupInput : digits[0]).focus();
        busy = false;
        submit.disabled = false;
        submit.textContent = 'Verify';
      }
    },
  },
    errorHost,
    inputHost,
    submit,
    el('p.mm-auth__foot',
      el('button.mm-link', {
        type: 'button',
        text: 'Use a backup code instead',
        onClick: toggleMode,
      })),
    el('p.mm-auth__foot',
      el('a.mm-link', {
        href: '/login',
        text: 'Sign in as someone else',
        onClick: () => { setToken(null); },
      })));

  function toggleMode(e) {
    usingBackup = !usingBackup;
    e.currentTarget.textContent = usingBackup
      ? 'Use your authenticator app instead'
      : 'Use a backup code instead';
    errorHost.replaceChildren();
    paint();
  }

  function paint() {
    if (usingBackup) {
      render(inputHost, field({
        label: 'Backup code', id: 'mm-backup', input: backupInput, required: true,
        hint: 'Each backup code works once. Using one here spends it.',
      }));
      backupInput.focus();
    } else {
      render(inputHost,
        el('label.mm-field__label', { text: 'Six-digit code from your authenticator app' }),
        el('div.mm-otp', ...digits));
      digits[0].focus();
    }
  }

  paint();

  return authLayout({
    title: 'Two-factor verification',
    subtitle: 'Your password was accepted. One more step.',
    form,
  });
}
