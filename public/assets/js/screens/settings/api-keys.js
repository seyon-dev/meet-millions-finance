/**
 * API keys.
 *
 * A key is shown once, at the moment it is created, and never again — only a
 * hash of it is stored. Scopes are the same permission keys the application
 * itself uses, so a key can never do more than a role could.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  skeletonTable, notify, notifyError, confirm, modal, banner, lockedState,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function apiKeysScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'API keys' }]);

  const page = el('div.mm-page');

  if (!session.hasFeature('api_access')) {
    page.append(
      pageHead({ title: 'API keys' }),
      lockedState({
        featureName: 'API access',
        requiredAddOn: 'api_marketplace',
        message: 'A documented REST API, with scoped keys and per-key rate limits.',
      }));
    return page;
  }

  const bodyHost = el('div');

  async function load() {
    render(bodyHost, skeletonTable(4, 3));
    try {
      const { data } = await api.get('/api-keys');
      render(bodyHost, ...build(data, load));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'API keys',
      subtitle: 'Keys for your own integrations, scoped to exactly what they need.',
      actions: session.can('api.manage')
        ? button('New key', { variant: 'primary', icon: 'key', onClick: () => createKey(load) })
        : null,
    }),
    bodyHost);

  await load();
  return page;
}

function build(data, reload) {
  const keys = data.keys ?? [];
  const live = keys.filter(k => k.status === 'active');

  return [
    banner({
      text: 'A key is shown once when it is created. Only a hash of it is stored here, so a lost key is replaced rather than recovered.',
      tone: 'info',
      icon: 'lock',
    }),

    keys.length
      ? el('div.mm-grid.mm-grid-4.mm-gap-4',
          stat({ label: 'Keys', value: fmt.number(keys.length), icon: 'key' }),
          stat({ label: 'Active', value: fmt.number(live.length), icon: 'check-circle', tone: 'success' }),
          stat({
            label: 'Requests today',
            value: fmt.number(keys.reduce((sum, k) => sum + (k.requestsToday ?? 0), 0)),
            icon: 'activity',
          }),
          stat({
            label: 'Last used',
            value: keys.some(k => k.lastUsedAt)
              ? fmt.relative(keys.map(k => k.lastUsedAt).filter(Boolean).sort().reverse()[0])
              : 'Never',
            icon: 'clock',
          }))
      : null,

    card({
      title: 'Keys',
      flush: true,
      body: keys.length
        ? el('ul.mm-list',
            ...keys.map(key => el('li.mm-list__row',
              el('span.mm-list__icon', { class: key.status === 'active' ? 'mm-c-success' : 'mm-muted' },
                icon('key', { size: 'sm' })),
              el('div.mm-list__main',
                el('span.mm-fw-medium', { text: key.name }),
                el('span.mm-muted.mm-text-xs.mm-mono', { text: `${key.prefix ?? 'mm'}…${key.last4 ?? ''}` }),
                el('span.mm-muted.mm-text-xs', {
                  text: [
                    `${fmt.plural((key.scopes ?? []).length, 'scope')}`,
                    `${key.rateLimitPerMin ?? 120}/min`,
                    key.lastUsedAt ? `last used ${fmt.relative(key.lastUsedAt)}` : 'never used',
                    key.expiresAt ? `expires ${fmt.date(key.expiresAt)}` : 'no expiry',
                  ].filter(Boolean).join(' · '),
                })),
              statusPill(key.status),
              session.can('api.manage')
                ? el('div.mm-row.mm-gap-1',
                    button('Usage', { variant: 'ghost', size: 'sm', onClick: () => showUsage(key) }),
                    button('Revoke', { variant: 'ghost', size: 'sm', onClick: () => revoke(key, reload) }))
                : null)))
        : emptyState({
            title: 'No keys yet',
            message: 'Create one when you have something to connect — an accounting package, a website form, your own script.',
            icon: 'key',
            inline: true,
            action: session.can('api.manage')
              ? { label: 'Create a key', onClick: () => createKey(reload) }
              : null,
          }),
    }),

    card({
      title: 'Using the API',
      body: frag(
        el('p.mm-prose', { text: 'Send the key as a bearer token. Every response carries the same envelope the interface uses.' }),
        el('pre.mm-code', {
          text: `curl ${window.location.origin}/api/clients \\\n  -H "Authorization: Bearer mm_live_..."`,
        }),
        el('p.mm-muted.mm-text-xs.mm-mt-2', {
          text: 'A key is limited by its scopes and by your plan, and every request it makes is recorded in the audit trail as that key.',
        })),
    }),
  ].filter(Boolean);
}

/**
 * Create a key.
 *
 * Scopes are chosen from the permission catalogue the server returns, grouped
 * the way the permission screen groups them, so the same names mean the same
 * things in both places.
 */
async function createKey(reload) {
  let scopes = [];
  try {
    ({ data: { availableScopes: scopes } } = await api.get('/api-keys'));
  } catch (err) {
    notifyError(err);
    return;
  }

  const groups = new Map();
  for (const scope of scopes) {
    const key = scope.category ?? 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(scope);
  }

  const payload = await modal({
    title: 'New API key',
    description: 'Give it only the scopes it needs. A key with more access than it uses is a key worth stealing.',
    size: 'lg',
    body: ({ close }) => {
      const name = el('input.mm-input', { placeholder: 'Website contact form' });
      const rateLimit = el('input.mm-input', { type: 'number', min: '1', max: '6000', value: '120' });
      const expiresIn = el('select.mm-select',
        el('option', { value: '', text: 'No expiry' }),
        ...[30, 90, 180, 365, 730].map(days => el('option', {
          value: String(days), selected: days === 365, text: `${days} days`,
        })));
      const allowedIps = el('input.mm-input.mm-mono', { placeholder: '203.0.113.7, 198.51.100.0/24' });

      const chosen = new Set();
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Name the key so you know what it is for.' }));
            return;
          }
          if (!chosen.size) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Choose at least one scope.' }));
            return;
          }
          close({
            name: name.value.trim(),
            scopes: [...chosen],
            rateLimitPerMin: Number(rateLimit.value) || 120,
            expiresInDays: expiresIn.value ? Number(expiresIn.value) : undefined,
            allowedIps: allowedIps.value.split(',').map(s => s.trim()).filter(Boolean),
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'What is it for?' }), name),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field',
            el('label.mm-field__label', { text: 'Requests a minute' }), rateLimit),
          el('div.mm-field', el('label.mm-field__label', { text: 'Expires after' }), expiresIn)),
        el('div.mm-field',
          el('label.mm-field__label', { text: 'Only from these addresses' }), allowedIps,
          el('p.mm-field__hint', { text: 'Optional. Comma-separated addresses or CIDR ranges.' })),

        el('h3.mm-label.mm-mt-4', { text: 'Scopes' }),
        el('div.mm-stack.mm-gap-3',
          ...[...groups.entries()].map(([category, items]) => el('details.mm-details',
            el('summary', { text: `${category} — ${fmt.plural(items.length, 'scope')}` }),
            el('div.mm-row.mm-gap-2.mm-wrap.mm-mt-2',
              ...items.map(scope => el('label.mm-chip.mm-chip--check',
                el('input.mm-sr-only', {
                  type: 'checkbox',
                  onChange: (e) => {
                    e.target.checked ? chosen.add(scope.key) : chosen.delete(scope.key);
                    e.target.closest('.mm-chip').classList.toggle('is-on', e.target.checked);
                  },
                }),
                el('span', { text: scope.name }),
                el('span.mm-muted.mm-text-2xs.mm-mono', { text: scope.key }))))))),

        el('div.mm-row.mm-end.mm-gap-2.mm-mt-5',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Create the key' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/api-keys', payload);
    await modal({
      title: 'Your new key',
      description: 'Copy it now. It is not stored in a form anybody can read, including us.',
      dismissible: false,
      body: ({ close }) => frag(
        el('pre.mm-code.mm-code--key', { text: data.key ?? data.apiKey ?? '' }),
        el('p.mm-muted.mm-text-xs.mm-mt-2', {
          text: `${payload.name} · ${fmt.plural(payload.scopes.length, 'scope')} · ${payload.rateLimitPerMin} requests a minute`,
        }),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', {
            type: 'button', text: 'Copy',
            onClick: () => {
              navigator.clipboard?.writeText(data.key ?? data.apiKey ?? '');
              notify.success('Copied.');
            },
          }),
          el('button.mm-btn.mm-btn--primary', {
            type: 'button', text: 'I have copied it', onClick: () => close(true),
          }))),
    });
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function showUsage(key) {
  try {
    const { data } = await api.get(`/api-keys/${key.id}/usage`);
    await modal({
      title: `${key.name} — usage`,
      size: 'lg',
      body: ({ close }) => frag(
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          stat({ label: 'Requests', value: fmt.number(data.total ?? 0), icon: 'activity' }),
          stat({ label: 'Rejected', value: fmt.number(data.rejected ?? 0), icon: 'x-circle', tone: data.rejected ? 'warning' : null }),
          stat({ label: 'Last used', value: data.lastUsedAt ? fmt.relative(data.lastUsedAt) : 'Never', icon: 'clock' })),

        (data.byDay ?? []).length
          ? el('div.mm-table-wrap.mm-mt-4',
              el('table.mm-table.mm-table--compact',
                el('thead', el('tr',
                  el('th', { text: 'Day' }),
                  el('th.mm-align-right', { text: 'Requests' }),
                  el('th.mm-align-right', { text: 'Rejected' }))),
                el('tbody',
                  ...data.byDay.map(day => el('tr',
                    el('td', { text: fmt.date(day.day) }),
                    el('td.mm-align-right.mm-numeric', { text: fmt.number(day.requests) }),
                    el('td.mm-align-right.mm-numeric', { text: fmt.number(day.rejected ?? 0) }))))))
          : el('p.mm-muted.mm-text-sm.mm-mt-4', { text: 'This key has not been used yet.' }),

        el('div.mm-row.mm-end.mm-mt-4',
          el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Close', onClick: () => close(null) }))),
    });
  } catch (err) {
    notifyError(err);
  }
}

async function revoke(key, reload) {
  const answer = await confirm({
    title: `Revoke “${key.name}”?`,
    message: 'Anything using this key stops working immediately.',
    detail: 'The key cannot be restored — a replacement has to be created.',
    confirmLabel: 'Revoke',
    tone: 'danger',
  });
  if (!answer) return;

  try {
    await api.delete(`/api-keys/${key.id}`);
    notify.success('Revoked.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
