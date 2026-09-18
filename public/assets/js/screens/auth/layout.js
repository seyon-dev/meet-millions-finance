/**
 * The signed-out layout, shared by sign-in, registration, password reset and
 * two-factor verification.
 *
 * A split screen: the form on the left, and on the right a panel that says
 * what the product actually does. The panel is hidden below the tablet
 * breakpoint, where it would push the form off the fold.
 */

import { el, frag } from '../../core/dom.js';
import { icon } from '../../core/icons.js';

const POINTS = [
  'Collect a month of documents from every client in one place',
  'Verify, query and approve without leaving the file',
  'GST and TDS computed from the documents you verified',
  'Reports your client signs off before you file',
];

export function authLayout({ title, subtitle, form, aside = null }) {
  return el('div.mm-auth',
    el('div.mm-auth__panel',
      el('div.mm-auth__brand',
        el('span.mm-brand-mark', { text: 'MM' }),
        el('div.mm-brand-text',
          el('span.mm-brand-text__name', { text: 'Meet Millions' }),
          el('span.mm-brand-text__sub', { text: 'Finance CRM' }))),

      el('div.mm-auth__card',
        el('h1.mm-auth__title', { text: title }),
        subtitle ? el('p.mm-auth__sub', { text: subtitle }) : null,
        form),

      el('p.mm-auth__legal.mm-muted.mm-text-xs',
        'Your session is protected with two-factor authentication where your organisation requires it.')),

    aside ?? el('aside.mm-auth__aside', { 'aria-hidden': 'true' },
      el('h2.mm-auth__headline', { text: 'The whole filing month, in one workspace' }),
      el('p.mm-auth__lede', {
        text: 'Meet Millions keeps document collection, verification, tax computation, client sign-off and billing in a single trail — so nothing is chased twice and nothing is filed twice.',
      }),
      el('ul.mm-auth__points',
        ...POINTS.map(point => el('li.mm-auth__point',
          el('span.mm-auth__point-mark', icon('check', { size: 'sm' })),
          el('span', { text: point })))),
      el('div.mm-auth__stats',
        stat('7', 'roles, each with its own view'),
        stat('30', 'add-on modules'),
        stat('13', 'integrations, connected when you have keys'))));
}

function stat(value, label) {
  return el('div',
    el('p.mm-auth__stat-v', { text: value }),
    el('p.mm-auth__stat-k', { text: label }));
}

/** A labelled form field. */
export function field({ label, input, id, hint = null, action = null, required = false }) {
  return el('div.mm-field',
    el('div.mm-row.mm-between.mm-baseline',
      el('label.mm-field__label', { for: id, text: label },
        required ? el('span.mm-field__req', { 'aria-hidden': 'true', text: '*' }) : null),
      action),
    input,
    hint ? el('p.mm-field__hint', { text: hint }) : null);
}

/**
 * A form-level error.
 *
 * role="alert" so it is announced the moment it appears: somebody using a
 * screen reader should not have to go hunting for why the form did not submit.
 */
export function formError(message) {
  return el('div.mm-banner.mm-banner--danger', { role: 'alert' },
    el('span.mm-banner__icon', icon('alert', { size: 'sm' })),
    el('p', { text: message }));
}

export function formNotice(message, tone = 'info') {
  return el('div.mm-banner', { class: `mm-banner--${tone}`, role: 'status' },
    el('span.mm-banner__icon', icon(tone === 'success' ? 'check-circle' : 'info', { size: 'sm' })),
    el('p', { text: message }));
}

/**
 * A password strength meter.
 *
 * Shows which of the policy's requirements are still unmet, rather than a bare
 * "weak": somebody told their password is weak cannot act on that, and
 * somebody told it needs a number can.
 */
export function passwordMeter(input, { minLength = 10 } = {}) {
  const bar = el('span.mm-meter__bar');
  const text = el('p.mm-field__hint', { text: `At least ${minLength} characters, with a mix of cases and a number.` });
  const meter = el('div.mm-meter', el('span.mm-meter__head', bar));

  input.addEventListener('input', () => {
    const value = input.value;
    const checks = {
      length: value.length >= minLength,
      lower: /[a-z]/.test(value),
      upper: /[A-Z]/.test(value),
      digit: /[0-9]/.test(value),
      long: value.length >= 14,
    };
    const score = Object.values(checks).filter(Boolean).length;

    bar.style.width = `${(score / 5) * 100}%`;
    bar.dataset.level = score <= 2 ? 'weak' : score === 3 ? 'fair' : score === 4 ? 'good' : 'strong';

    const missing = [];
    if (!checks.length) missing.push(`${minLength} characters`);
    if (!checks.lower) missing.push('a lowercase letter');
    if (!checks.upper) missing.push('a capital letter');
    if (!checks.digit) missing.push('a number');

    text.textContent = value === ''
      ? `At least ${minLength} characters, with a mix of cases and a number.`
      : (missing.length ? `Still needs ${missing.join(', ')}.` : 'Strong enough.');
  });

  return frag(meter, text);
}
