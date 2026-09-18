/**
 * Create an organisation.
 *
 * Two steps rather than one long form: who you are, then what your practice
 * is. A single fourteen-field form is where sign-ups are abandoned, and the
 * second step's fields (GSTIN, PAN, TAN) are the ones people have to go and
 * look up.
 */

import { el, frag, render } from '../../core/dom.js';
import { api } from '../../core/api.js';
import * as session from '../../core/session.js';
import * as router from '../../core/router.js';
import { button } from '../../core/ui.js';
import { authLayout, field, formError, passwordMeter } from './layout.js';

export default async function registerScreen() {
  let step = 1;
  let busy = false;
  const values = {};

  const errorHost = el('div');
  const formHost = el('div');

  const form = el('form.mm-auth__form', {
    novalidate: true,
    onSubmit: (e) => { e.preventDefault(); step === 1 ? goToStep2() : submit(); },
  }, errorHost, formHost);

  // ---- Step 1: the person ---------------------------------------------------
  const fullName = input({ id: 'mm-name', autocomplete: 'name', placeholder: 'Asha Menon' });
  const email = input({ id: 'mm-email', type: 'email', autocomplete: 'email', placeholder: 'you@firm.example' });
  const phone = input({ id: 'mm-phone', type: 'tel', autocomplete: 'tel', placeholder: '98450 12233' });
  const password = input({ id: 'mm-password', type: 'password', autocomplete: 'new-password' });

  // ---- Step 2: the practice -------------------------------------------------
  const orgName = input({ id: 'mm-org', placeholder: 'Meridian Tax Associates' });
  const companyName = input({ id: 'mm-company', placeholder: 'Meridian Tax Associates LLP' });
  const gstin = input({ id: 'mm-gstin', placeholder: '33AABCR1234M1ZK', maxlength: '15', style: { textTransform: 'uppercase' } });
  const pan = input({ id: 'mm-pan', placeholder: 'AABCR1234M', maxlength: '10', style: { textTransform: 'uppercase' } });
  const tan = input({ id: 'mm-tan', placeholder: 'CHEN12345A', maxlength: '10', style: { textTransform: 'uppercase' } });

  function input(props) {
    return el('input.mm-input', { required: true, ...props });
  }

  function paintStep1() {
    render(formHost,
      el('p.mm-eyebrow', { text: 'Step 1 of 2 — About you' }),
      field({ label: 'Your name', id: 'mm-name', input: fullName, required: true }),
      field({ label: 'Work email', id: 'mm-email', input: email, required: true }),
      field({ label: 'Mobile number', id: 'mm-phone', input: phone, required: true }),
      field({
        label: 'Password', id: 'mm-password', input: password, required: true,
        hint: null,
      }),
      passwordMeter(password),
      blockButton('Continue'),
      el('p.mm-auth__foot',
        'Already have an account? ',
        el('a.mm-link', { href: '/login', text: 'Sign in' })));
    fullName.focus();
  }

  function paintStep2() {
    render(formHost,
      el('p.mm-eyebrow', { text: 'Step 2 of 2 — Your practice' }),
      field({ label: 'Organisation name', id: 'mm-org', input: orgName, required: true }),
      field({
        label: 'Registered company name', id: 'mm-company', input: companyName, required: true,
        hint: 'As it appears on your GST registration.',
      }),
      field({
        label: 'GSTIN', id: 'mm-gstin', input: gstin, required: true,
        hint: 'Fifteen characters. Your PAN is taken from it automatically.',
      }),
      field({ label: 'PAN', id: 'mm-pan', input: pan, required: true }),
      field({
        label: 'TAN', id: 'mm-tan', input: tan, required: true,
        hint: 'Needed for TDS returns.',
      }),
      el('div.mm-row.mm-gap-2',
        button('Back', {
          variant: 'ghost',
          onClick: () => { step = 1; errorHost.replaceChildren(); paintStep1(); },
        }),
        blockButton('Create organisation')));

    // Derive the PAN from the GSTIN as it is typed: characters 3–12 are the
    // PAN by construction, and re-typing it is a chance to get it wrong.
    gstin.addEventListener('input', () => {
      gstin.value = gstin.value.toUpperCase();
      if (gstin.value.length >= 12 && !pan.value) pan.value = gstin.value.slice(2, 12);
    });
    orgName.focus();
  }

  function blockButton(label) {
    const node = button(label, { variant: 'primary', type: 'submit' });
    node.classList.add('mm-btn--block');
    return node;
  }

  function goToStep2() {
    const missing = [
      [fullName, 'your name'], [email, 'your email address'],
      [phone, 'your mobile number'], [password, 'a password'],
    ].find(([node]) => !node.value.trim());

    if (missing) {
      errorHost.replaceChildren(formError(`Please enter ${missing[1]}.`));
      missing[0].focus();
      return;
    }
    if (password.value.length < 10) {
      errorHost.replaceChildren(formError('Your password needs at least ten characters.'));
      password.focus();
      return;
    }

    Object.assign(values, {
      fullName: fullName.value.trim(),
      email: email.value.trim(),
      phone: phone.value.trim(),
      password: password.value,
    });

    // The organisation name is usually the practice's name; offering it saves
    // typing and is easy to change.
    if (!orgName.value) orgName.value = '';
    step = 2;
    errorHost.replaceChildren();
    paintStep2();
  }

  async function submit() {
    if (busy) return;
    busy = true;
    errorHost.replaceChildren();

    const payload = {
      ...values,
      organisationName: orgName.value.trim(),
      companyName: companyName.value.trim(),
      gstin: gstin.value.trim().toUpperCase(),
      pan: pan.value.trim().toUpperCase(),
      tan: tan.value.trim().toUpperCase(),
      stateCode: gstin.value.trim().slice(0, 2),
    };

    try {
      const { data } = await api.post('/auth/register', payload);
      await session.signIn(data.token);
      const { enterApp } = await import('../../app.js');
      await enterApp();
      router.go(data.landing || session.landingPath(), { replace: true });
    } catch (err) {
      // Field errors are attached where the problem is; anything else goes to
      // the banner. Sending somebody back to step 1 for a GSTIN typo would be
      // its own small insult.
      if (err.name === 'ValidationError') {
        const fields = err.fields ?? {};
        const first = Object.entries(fields)[0];
        errorHost.replaceChildren(formError(first ? first[1] : err.message));
        ({
          gstin, pan, tan, companyName, organisationName: orgName,
          email, password, fullName, phone,
        }[first?.[0]])?.focus?.();
      } else {
        errorHost.replaceChildren(formError(err.message));
      }
      busy = false;
    }
  }

  paintStep1();

  return authLayout({
    title: 'Create your organisation',
    subtitle: 'Two minutes, and your first filing month is ready to collect.',
    form,
  });
}
