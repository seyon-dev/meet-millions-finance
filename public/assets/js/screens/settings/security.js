/**
 * Security.
 *
 * Your own account's protection at the top, and — for an administrator — the
 * organisation's policy beneath it. Both live here because "am I safe" and
 * "are we safe" are the same question asked at two scales.
 *
 * Two-factor is set up in place with a real QR code and a real verification
 * step: nothing is enabled until a code from the authenticator app has been
 * checked against the secret.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  skeletonTable, notify, notifyError, confirm, modal, banner, promptText,
} from '../../core/ui.js';
import { qrSvg } from '../../core/qr.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function securityScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Security' }]);

  const page = el('div.mm-page');
  const mineHost = el('div.mm-stack.mm-gap-4');
  const orgHost = el('div.mm-stack.mm-gap-4');

  async function loadMine() {
    render(mineHost, skeletonTable(4, 2));
    try {
      const { data: sessions } = await api.get('/auth/sessions');
      render(mineHost,
        twoFactorCard(loadMine),
        sessionsCard(sessions ?? [], loadMine));
    } catch (err) {
      render(mineHost, errorState(err, { onRetry: loadMine }));
    }
  }

  async function loadOrg() {
    // No organisation, no organisation policy: the platform owner's security
    // is their own two-factor and sessions, on the left.
    if (!session.can('settings.manage') || session.isPlatformOnly()) { render(orgHost); return; }
    render(orgHost, skeletonTable(6, 2));
    try {
      const { data } = await api.get('/settings/security');
      render(orgHost,
        adoptionCard(data.adoption),
        policyCard(data, loadOrg),
        allowlistCard(data, loadOrg));
    } catch (err) {
      render(orgHost, errorState(err, { onRetry: loadOrg }));
    }
  }

  page.append(
    pageHead({
      title: 'Security',
      subtitle: session.can('settings.manage') && !session.isPlatformOnly()
        ? 'Your account, and the rules everybody in the organisation is held to.'
        : 'How your account is protected.',
    }),
    // The platform owner has no organisation column, so their own security
    // takes the full width rather than leaving an empty half.
    session.isPlatformOnly()
      ? el('div.mm-stack.mm-gap-4', mineHost)
      : el('div.mm-grid.mm-grid-2-1.mm-gap-4', mineHost, orgHost));

  await Promise.all([loadMine(), loadOrg()]);
  return page;
}

// ---------------------------------------------------------------------------
// Your account
// ---------------------------------------------------------------------------
function twoFactorCard(reload) {
  const user = session.session().user ?? {};

  return card({
    title: 'Two-factor authentication',
    subtitle: user.twoFactorEnabled
      ? 'On. A code from your authenticator app is needed at every sign-in.'
      : 'Off. Your password alone is enough to sign in as you.',
    actions: user.twoFactorEnabled
      ? frag(
          button('New recovery codes', { variant: 'ghost', size: 'sm', onClick: () => regenerateCodes() }),
          button('Turn off', { variant: 'ghost', size: 'sm', onClick: () => disable(reload) }))
      : button('Turn it on', { variant: 'primary', size: 'sm', icon: 'shield', onClick: () => setUp(reload) }),
    body: user.twoFactorEnabled
      ? el('div.mm-row.mm-gap-3.mm-center',
          icon('shield', { size: 'lg', className: 'mm-c-success' }),
          el('div',
            el('p.mm-fw-medium', { text: 'This account is protected by a second factor.' }),
            el('p.mm-muted.mm-text-sm', {
              text: 'Keep your recovery codes somewhere you can reach without your phone.',
            })))
      : banner({
          text: 'Somebody who learns your password can sign in as you, read every client’s documents, and act as you in the audit trail.',
          tone: 'warning',
          icon: 'alert',
        }),
  });
}

/**
 * Turn two-factor on.
 *
 * The QR code is drawn from the otpauth:// URI the server produced; the secret
 * is also shown in text, because not every authenticator can scan and somebody
 * setting this up on the same device cannot photograph their own screen.
 */
async function setUp(reload) {
  let setup;
  try {
    ({ data: setup } = await api.post('/auth/2fa/setup', {}));
  } catch (err) {
    notifyError(err);
    return;
  }

  const code = await modal({
    title: 'Set up two-factor authentication',
    description: 'Scan this with Google Authenticator, Authy, 1Password or any TOTP app.',
    size: 'lg',
    dismissible: true,
    body: ({ close }) => {
      const input = el('input.mm-input.mm-mono', {
        inputmode: 'numeric', maxlength: '6', placeholder: '123456', autocomplete: 'one-time-code',
      });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!/^\d{6}$/.test(input.value.trim())) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'Enter the six-digit code from your app.',
            }));
            return;
          }
          close(input.value.trim());
        },
      },
        el('div.mm-row.mm-gap-5.mm-wrap',
          el('div.mm-qr', qrSvg(setup.uri)),
          el('div.mm-stack.mm-gap-3',
            el('div',
              el('p.mm-label', { text: 'Or enter this key by hand' }),
              el('p.mm-mono.mm-text-sm', { text: setup.secret }),
              el('p.mm-muted.mm-text-xs', {
                text: `${setup.issuer} · ${setup.account} · ${setup.digits} digits · every ${setup.period}s`,
              })),
            el('div.mm-field',
              el('label.mm-field__label', { text: 'Code from your app' }),
              input,
              el('p.mm-field__hint', { text: 'Nothing is switched on until this code checks out.' })),
            errorHost)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Verify and turn on' })));
    },
  });
  if (!code) return;

  try {
    const { data } = await api.post('/auth/2fa/enable', { code });
    await session.load();
    await showBackupCodes(data.backupCodes, data.message);
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function showBackupCodes(codes, message) {
  await modal({
    title: 'Your recovery codes',
    description: message,
    dismissible: false,
    body: ({ close }) => frag(
      el('p.mm-prose', {
        text: 'Each code works once, and only when you cannot use your authenticator app. Store them where you would store a spare key.',
      }),
      el('ul.mm-codes', ...(codes ?? []).map(code => el('li.mm-mono', { text: code }))),
      el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
        el('button.mm-btn.mm-btn--ghost', {
          type: 'button', text: 'Copy them',
          onClick: () => {
            navigator.clipboard?.writeText((codes ?? []).join('\n'));
            notify.success('Copied.');
          },
        }),
        el('button.mm-btn.mm-btn--primary', {
          type: 'button', text: 'I have saved them', onClick: () => close(true),
        }))),
  });
}

async function regenerateCodes() {
  const password = await promptText({
    title: 'New recovery codes',
    message: 'The codes you have now stop working immediately.',
    label: 'Your password',
    multiline: false,
    confirmLabel: 'Generate',
  });
  if (!password) return;

  try {
    const { data } = await api.post('/auth/2fa/backup-codes', { password });
    await showBackupCodes(data.backupCodes, 'These replace your previous codes.');
  } catch (err) {
    notifyError(err);
  }
}

async function disable(reload) {
  const password = await promptText({
    title: 'Turn off two-factor authentication?',
    message: 'Your password alone will be enough to sign in as you. Your organisation may require a second factor, in which case this will be refused.',
    label: 'Your password',
    multiline: false,
    confirmLabel: 'Turn it off',
    tone: 'danger',
  });
  if (!password) return;

  try {
    await api.post('/auth/2fa/disable', { password });
    await session.load();
    notify.success('Two-factor is off.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

function sessionsCard(sessions, reload) {
  const active = sessions.filter(s => s.active);

  return card({
    title: 'Where you are signed in',
    subtitle: `${fmt.plural(active.length, 'active session')}`,
    actions: active.length > 1
      ? button('Sign out everywhere else', {
          variant: 'ghost', size: 'sm',
          onClick: () => revokeOthers(reload),
        })
      : null,
    flush: true,
    body: sessions.length
      ? el('ul.mm-list',
          ...sessions.map(s => el('li.mm-list__row',
            el('span.mm-list__icon', { class: s.current ? 'mm-c-brand' : 'mm-muted' },
              icon(/mobile|android|iphone/i.test(s.userAgent ?? '') ? 'smartphone' : 'grid', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: shortAgent(s.userAgent) }),
              el('span.mm-muted.mm-text-xs', {
                text: [
                  s.ip,
                  `signed in ${fmt.relative(s.createdAt)}`,
                  s.lastSeenAt ? `last used ${fmt.relative(s.lastSeenAt)}` : null,
                ].filter(Boolean).join(' · '),
              })),
            s.current ? pill('This device', 'info') : null,
            s.active
              ? (s.current ? null : button('End', {
                  variant: 'ghost', size: 'sm', onClick: () => revoke(s, reload),
                }))
              : pill('Ended', 'neutral'))))
      : emptyState({ title: 'No sessions recorded', icon: 'lock', inline: true }),
  });
}

function shortAgent(userAgent) {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg/.test(userAgent) ? 'Edge'
    : /Chrome/.test(userAgent) ? 'Chrome'
      : /Safari/.test(userAgent) ? 'Safari'
        : /Firefox/.test(userAgent) ? 'Firefox' : 'A browser';
  const os = /Windows/.test(userAgent) ? 'Windows'
    : /Mac OS/.test(userAgent) ? 'macOS'
      : /Android/.test(userAgent) ? 'Android'
        : /iPhone|iPad/.test(userAgent) ? 'iOS'
          : /Linux/.test(userAgent) ? 'Linux' : 'an unknown system';
  return `${browser} on ${os}`;
}

async function revoke(target, reload) {
  try {
    await api.delete(`/auth/sessions/${target.id}`);
    notify.success('That session has been ended.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function revokeOthers(reload) {
  const answer = await confirm({
    title: 'Sign out everywhere else?',
    message: 'Every other device is signed out immediately. This one stays.',
    confirmLabel: 'Sign them out',
  });
  if (!answer) return;

  try {
    const { data } = await api.post('/auth/sessions/revoke-others', {});
    notify.success(`${fmt.plural(data?.revoked ?? 0, 'session')} ended.`);
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

// ---------------------------------------------------------------------------
// The organisation's policy
// ---------------------------------------------------------------------------
function adoptionCard(adoption) {
  if (!adoption) return null;
  return card({
    title: 'Two-factor across the practice',
    body: frag(
      el('div.mm-row.mm-gap-3.mm-center',
        el('span.mm-progress',
          el('span.mm-progress__bar', {
            class: adoption.twoFactorPct >= 90 ? 'mm-progress__bar--success' : adoption.twoFactorPct >= 50 ? 'mm-progress__bar--warning' : 'mm-progress__bar--danger',
            style: { width: `${adoption.twoFactorPct ?? 0}%` },
          })),
        el('span.mm-fw-medium.mm-numeric', { text: `${adoption.twoFactorPct ?? 0}%` })),
      el('p.mm-muted.mm-text-sm.mm-mt-2', {
        text: `${fmt.number(adoption.twoFactorUsers)} of ${fmt.number(adoption.activeUsers)} active accounts have a second factor.`,
      })),
  });
}

/**
 * The policy.
 *
 * Every field is rendered from the server's own defaults where the
 * organisation has not set one, so the screen always shows what is actually
 * in force rather than a blank.
 */
/** Stored column name → the name PATCH /settings/security validates. */
const CAMEL = {
  session_ttl_hours: 'sessionTtlHours',
  idle_timeout_minutes: 'idleTimeoutMinutes',
  password_min_length: 'passwordMinLength',
  password_expiry_days: 'passwordExpiryDays',
  max_failed_logins: 'maxFailedLogins',
  lockout_minutes: 'lockoutMinutes',
  enforce_2fa: 'enforce2fa',
  password_require_mixed: 'passwordRequireMixed',
  ip_allowlist_enabled: 'ipAllowlistEnabled',
  device_approval: 'deviceApproval',
  anomaly_alerts: 'anomalyAlerts',
  step_up_for_sensitive: 'stepUpForSensitive',
};

function policyCard(data, reload) {
  const policy = { ...data.defaults, ...data.policy };

  const fields = {
    session_ttl_hours: { label: 'Session length (hours)', type: 'number', min: 1, max: 720 },
    idle_timeout_minutes: { label: 'Idle timeout (minutes)', type: 'number', min: 5, max: 1440 },
    password_min_length: { label: 'Minimum password length', type: 'number', min: 8, max: 64 },
    password_expiry_days: { label: 'Password expires after (days, 0 for never)', type: 'number', min: 0, max: 365 },
    max_failed_logins: { label: 'Failed sign-ins before lockout', type: 'number', min: 3, max: 20 },
    lockout_minutes: { label: 'Lockout length (minutes)', type: 'number', min: 1, max: 1440 },
  };

  const toggles = {
    enforce_2fa: 'Require two-factor for everybody',
    password_require_mixed: 'Passwords must mix upper case, lower case and digits',
    ip_allowlist_enabled: 'Only allow sign-in from the addresses below',
    device_approval: 'A new device must be approved before it can sign in',
    anomaly_alerts: 'Alert on unusual sign-ins',
    step_up_for_sensitive: 'Ask again for a code before sensitive actions',
  };

  const inputs = {};

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;

      // The API validates camelCase names; the rows this card reads are the
      // stored snake_case columns. Sending the column names straight back —
      // which this form used to do — meant validate() saw none of its fields
      // and every save failed with "Nothing to update". The form never saved
      // a policy, not once.
      const payload = {};
      for (const key of Object.keys(fields)) payload[CAMEL[key]] = Number(inputs[key].value);
      for (const key of Object.keys(toggles)) payload[CAMEL[key]] = inputs[key].checked;

      try {
        await api.patch('/settings/security', payload);
        notify.success('Policy saved. It applies from everybody’s next request.');
        await reload();
      } catch (err) {
        notifyError(err);
      } finally {
        submitButton.disabled = false;
      }
    },
  },
    el('div.mm-grid.mm-grid-2.mm-gap-3',
      ...Object.entries(fields).map(([key, field]) => {
        inputs[key] = el('input.mm-input', {
          type: 'number', min: String(field.min), max: String(field.max),
          value: String(policy[key] ?? 0),
        });
        return el('div.mm-field', el('label.mm-field__label', { text: field.label }), inputs[key]);
      })),

    el('div.mm-stack.mm-gap-2.mm-mt-4',
      ...Object.entries(toggles).map(([key, label]) => {
        inputs[key] = el('input.mm-checkbox', { type: 'checkbox', checked: !!policy[key] });
        return el('label.mm-switch', inputs[key], el('span.mm-switch__text', el('span', { text: label })));
      })),

    el('div.mm-row.mm-end.mm-mt-4',
      el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save the policy' })));

  return card({
    title: 'Security policy',
    subtitle: data.policy?.updated_at ? `Last changed ${fmt.relative(data.policy.updated_at)}` : 'Using the defaults.',
    body: form,
  });
}

/** The IP allowlist. Enforcing it while it is empty would lock everybody out. */
function allowlistCard(data, reload) {
  const entries = data.ipAllowlist ?? [];
  const enabled = !!(data.policy?.ip_allowlist_enabled);

  return card({
    title: 'IP allowlist',
    subtitle: enabled
      ? 'Enforced. Only these addresses can sign in.'
      : 'Not enforced — these addresses are recorded but not required.',
    actions: button('Add an address', {
      variant: 'ghost', size: 'sm', icon: 'plus',
      onClick: () => addAddress(reload),
    }),
    flush: true,
    body: frag(
      enabled && !entries.length
        ? banner({
            text: 'The allowlist is switched on and empty. Add this office’s address before anybody signs out.',
            tone: 'danger',
            icon: 'alert',
          })
        : null,

      entries.length
        ? el('ul.mm-list',
            ...entries.map(entry => el('li.mm-list__row',
              el('span.mm-list__icon.mm-muted', icon('network', { size: 'sm' })),
              el('div.mm-list__main',
                el('span.mm-fw-medium.mm-mono', { text: entry.cidr }),
                el('span.mm-muted.mm-text-xs', {
                  text: [entry.label, `added ${fmt.relative(entry.created_at)}`].filter(Boolean).join(' · '),
                })),
              button('Remove', {
                variant: 'ghost', size: 'sm',
                onClick: () => removeAddress(entry, reload),
              }))))
        : emptyState({
            title: 'No addresses',
            message: 'An allowlist restricts sign-in to your own office networks.',
            icon: 'network',
            inline: true,
          })),
  });
}

async function addAddress(reload) {
  const payload = await modal({
    title: 'Add an address to the allowlist',
    size: 'sm',
    body: ({ close }) => {
      const cidr = el('input.mm-input.mm-mono', { placeholder: '203.0.113.0/24' });
      const label = el('input.mm-input', { placeholder: 'Chennai office' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!cidr.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Enter an address or a range.' }));
            return;
          }
          close({ cidr: cidr.value.trim(), label: label.value.trim() || undefined });
        },
      },
        errorHost,
        el('div.mm-field',
          el('label.mm-field__label', { text: 'Address or range' }), cidr,
          el('p.mm-field__hint', { text: 'A single address, or a CIDR range like 203.0.113.0/24.' })),
        el('div.mm-field', el('label.mm-field__label', { text: 'What is it?' }), label),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Add' })));
    },
  });
  if (!payload) return;

  try {
    await api.post('/settings/security/ip-allowlist', payload);
    notify.success('Added.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function removeAddress(entry, reload) {
  const answer = await confirm({
    title: `Remove ${entry.cidr}?`,
    message: 'If the allowlist is enforced, nobody on that network will be able to sign in.',
    confirmLabel: 'Remove',
    tone: 'danger',
  });
  if (!answer) return;

  try {
    await api.delete(`/settings/security/ip-allowlist/${entry.id}`);
    notify.success('Removed.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
