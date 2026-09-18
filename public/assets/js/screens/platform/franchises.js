/**
 * Franchises.
 *
 * A franchise owns a group of organisations and takes a share of what they
 * pay. The share is shown as both a percentage and the money it came to this
 * month, because a percentage on its own settles no argument.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  skeletonTiles, notify, notifyError, modal,
} from '../../core/ui.js';
import { rankBars } from '../../components/charts.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function franchisesScreen() {
  setBreadcrumbs([{ label: 'Platform' }, { label: 'Franchises' }]);

  const page = el('div.mm-page');
  const bodyHost = el('div');

  async function load() {
    render(bodyHost, skeletonTiles(3));
    try {
      const { data } = await api.get('/platform/franchises');
      render(bodyHost, ...build(data.franchises ?? [], load));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Franchises',
      subtitle: 'Partners who bring organisations on to the platform, and what they earn.',
      actions: session.can('franchises.manage')
        ? button('Add a franchise', { variant: 'primary', icon: 'plus', onClick: () => openFranchise(null, load) })
        : null,
    }),
    bodyHost);

  await load();
  return page;
}

function build(franchises, reload) {
  if (!franchises.length) {
    return [emptyState({
      title: 'No franchises',
      message: 'A franchise brings organisations on to the platform and takes an agreed share of what they pay.',
      icon: 'network',
      action: session.can('franchises.manage')
        ? { label: 'Add one', onClick: () => openFranchise(null, reload) }
        : null,
    })];
  }

  const totals = franchises.reduce((acc, f) => ({
    tenants: acc.tenants + (f.tenantCount ?? 0),
    gross: acc.gross + (f.thisMonth?.grossPaise ?? 0),
    share: acc.share + (f.thisMonth?.sharePaise ?? 0),
  }), { tenants: 0, gross: 0, share: 0 });

  return [
    el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Franchises', value: fmt.number(franchises.length), icon: 'network' }),
      stat({ label: 'Organisations', value: fmt.number(totals.tenants), icon: 'building' }),
      stat({ label: 'Collected this month', value: fmt.moneyShort(totals.gross), icon: 'rupee' }),
      stat({
        label: 'Owed to franchises',
        value: fmt.moneyShort(totals.share),
        icon: 'trending-up',
        tone: totals.share > 0 ? 'warning' : null,
      })),

    card({
      title: 'This month’s share',
      className: 'mm-mt-4',
      body: rankBars({
        rows: franchises.map(f => ({
          label: f.name,
          value: f.thisMonth?.sharePaise ?? 0,
          valueLabel: `${fmt.money(f.thisMonth?.sharePaise ?? 0)} of ${fmt.money(f.thisMonth?.grossPaise ?? 0)}`,
        })),
        unit: 'paise',
        emptyMessage: 'Nothing has been collected this month.',
      }),
    }),

    el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
      ...franchises.map(franchise => card({
        title: franchise.name,
        subtitle: [franchise.code, franchise.city, franchise.state].filter(Boolean).join(' · '),
        actions: frag(
          statusPill(franchise.status),
          session.can('franchises.manage')
            ? button('Edit', {
                variant: 'ghost', size: 'sm', icon: 'edit',
                onClick: () => openFranchise(franchise, reload),
              })
            : null),
        body: el('div.mm-kvgrid',
          kv('Owner', franchise.owner?.name),
          kv('Email', franchise.owner?.email),
          kv('Phone', franchise.owner?.phone),
          kv('Organisations', franchise.tenantCount),
          kv('Revenue share', `${franchise.revenueSharePct}%`),
          kv('Collected this month', fmt.money(franchise.thisMonth?.grossPaise ?? 0)),
          kv('Their share', fmt.money(franchise.thisMonth?.sharePaise ?? 0)),
          kv('Onboarded', franchise.onboardedAt ? fmt.date(franchise.onboardedAt) : null)),
      }))),
  ].filter(Boolean);
}

async function openFranchise(existing, reload) {
  const payload = await modal({
    title: existing ? `Edit ${existing.name}` : 'Add a franchise',
    body: ({ close }) => {
      const name = el('input.mm-input', { value: existing?.name ?? '', placeholder: 'Southern Region Partners' });
      const code = el('input.mm-input', {
        value: existing?.code ?? '', maxlength: '20', placeholder: 'SRP',
        style: { textTransform: 'uppercase' },
      });
      const ownerName = el('input.mm-input', { value: existing?.owner?.name ?? '' });
      const ownerEmail = el('input.mm-input', { type: 'email', value: existing?.owner?.email ?? '' });
      const ownerPhone = el('input.mm-input', { type: 'tel', value: existing?.owner?.phone ?? '' });
      const city = el('input.mm-input', { value: existing?.city ?? '' });
      const state = el('input.mm-input', { value: existing?.state ?? '' });
      const share = el('input.mm-input', {
        type: 'number', min: '0', max: '100', step: '0.5',
        value: String(existing?.revenueSharePct ?? 20),
      });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim() || !code.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'A franchise needs a name and a code.',
            }));
            return;
          }
          close({
            name: name.value.trim(),
            code: code.value.trim().toUpperCase(),
            ownerName: ownerName.value.trim() || undefined,
            ownerEmail: ownerEmail.value.trim() || undefined,
            ownerPhone: ownerPhone.value.trim() || undefined,
            city: city.value.trim() || undefined,
            state: state.value.trim() || undefined,
            revenueSharePct: Number(share.value) || 0,
          });
        },
      },
        errorHost,
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), name),
          el('div.mm-field', el('label.mm-field__label', { text: 'Code' }), code)),
        el('h3.mm-label.mm-mt-3', { text: 'Who runs it' }),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), ownerName),
          el('div.mm-field', el('label.mm-field__label', { text: 'Email' }), ownerEmail),
          el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), ownerPhone)),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'City' }), city),
          el('div.mm-field', el('label.mm-field__label', { text: 'State' }), state),
          el('div.mm-field',
            el('label.mm-field__label', { text: 'Revenue share (%)' }), share,
            el('p.mm-field__hint', { text: 'Of what their organisations pay.' }))),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: existing ? 'Save' : 'Add it' })));
    },
  });
  if (!payload) return;

  try {
    if (existing) await api.patch(`/platform/franchises/${existing.id}`, payload);
    else await api.post('/platform/franchises', payload);
    notify.success(existing ? 'Saved.' : `${payload.name} added.`);
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
