/**
 * Organisations, across the whole platform.
 *
 * Super Admin only, and deliberately separate from everything else: this is
 * the one place where the tenant scope is stepped outside, and it looks
 * different so that nobody is ever unsure which they are looking at.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, confirm, modal, banner, promptText,
} from '../../core/ui.js';
import { dataTable, selectFilter } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function tenantsScreen() {
  setBreadcrumbs([{ label: 'Platform' }, { label: 'Organisations' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');

  const plans = await api.get('/platform/plans').then(r => r.data?.plans ?? []).catch(() => []);

  const table = dataTable({
    searchPlaceholder: 'Search by name, GSTIN or owner…',
    // The command palette links here with the organisation's name, so the
    // list opens on the one that was searched for rather than on all of them.
    initialQuery: new URLSearchParams(window.location.search).get('q') ?? '',
    defaultSort: 'created_at',
    onRowClick: (row) => openTenant(row, plans, table),
    filters: (apply, active) => [
      selectFilter({
        label: 'Status',
        options: ['active', 'trial', 'suspended', 'cancelled'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
      plans.length
        ? selectFilter({
            label: 'Plan',
            options: plans.map(p => ({ value: p.key, label: p.name })),
            value: active.planKey ?? '',
            onChange: v => apply('planKey', v),
          })
        : null,
    ].filter(Boolean),
    toolbar: ({ refresh }) => (session.can('tenants.create')
      ? [button('Add an organisation', { variant: 'primary', icon: 'plus', onClick: () => createTenant(refresh) })]
      : []),
    load: async (params) => {
      const { data, meta } = await api.get('/platform/tenants', params);
      paintTiles(meta.summary);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'name',
        label: 'Organisation',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.name }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.gstin, row.franchiseName].filter(Boolean).join(' · '),
          })),
      },
      {
        key: 'planName',
        label: 'Plan',
        render: row => (row.planName
          ? el('div.mm-stack',
              pill(row.planName, 'info'),
              row.subscriptionStatus === 'trialing'
                ? el('span.mm-muted.mm-text-xs', { text: 'On trial' })
                : null)
          : el('span.mm-muted.mm-text-xs', { text: 'No plan' })),
      },
      {
        key: 'userCount',
        label: 'Users',
        align: 'right',
        hideOnMobile: true,
        render: row => el('span.mm-numeric', { text: fmt.number(row.userCount ?? 0) }),
      },
      {
        key: 'clientCount',
        label: 'Clients',
        align: 'right',
        hideOnMobile: true,
        render: row => el('span.mm-numeric', { text: fmt.number(row.clientCount ?? 0) }),
      },
      {
        key: 'documentCount',
        label: 'Documents',
        align: 'right',
        hideOnMobile: true,
        render: row => el('span.mm-numeric', { text: fmt.number(row.documentCount ?? 0) }),
      },
      {
        key: 'status',
        label: 'Status',
        render: row => frag(
          statusPill(row.status),
          row.isDemo ? pill('Demo', 'neutral') : null),
      },
      { key: 'createdAt', label: 'Joined', format: 'date', hideOnMobile: true },
    ],
    empty: {
      title: 'No organisations',
      message: 'Every practice using the platform appears here.',
      icon: 'building',
    },
  });

  function paintTiles(summary) {
    if (!summary) return;
    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Organisations', value: fmt.number(summary.total ?? 0), icon: 'building' }),
      stat({ label: 'Active', value: fmt.number(summary.active ?? 0), icon: 'check-circle', tone: 'success' }),
      stat({ label: 'On trial', value: fmt.number(summary.trial ?? 0), icon: 'clock' }),
      stat({
        label: 'Suspended',
        value: fmt.number(summary.suspended ?? 0),
        icon: 'lock',
        tone: (summary.suspended ?? 0) > 0 ? 'warning' : null,
      })));
  }

  page.append(
    pageHead({
      title: 'Organisations',
      subtitle: 'Every practice on the platform.',
      actions: button('Revenue', { variant: 'ghost', icon: 'trending-up', href: '/platform/revenue' }),
    }),
    banner({
      text: 'This screen steps outside a single organisation. Everything you do here is recorded in the platform trail and, where it touches one organisation, in theirs.',
      tone: 'warning',
      icon: 'shield',
    }),
    tileHost,
    card({ body: table.node, flush: true }));

  // Arriving from the dashboard's "New organisation" with ?new=1 opens the form
  // rather than landing on the list and leaving somebody to find the button.
  if (new URLSearchParams(window.location.search).get('new') === '1') {
    router.setQuery({ new: null });
    queueMicrotask(() => createTenant(() => table.refresh()));
  }

  return page;
}

/** One organisation: what they are on, what they use, and who owns it. */
async function openTenant(tenant, plans, table) {
  let detail = null;
  try {
    ({ data: detail } = await api.get(`/platform/tenants/${tenant.id}`));
  } catch (err) {
    notifyError(err);
    return;
  }

  const result = await modal({
    title: detail.tenant.name,
    description: [detail.tenant.gstin, detail.tenant.email].filter(Boolean).join(' · ') || null,
    size: 'lg',
    body: ({ close }) => frag(
      el('div.mm-grid.mm-grid-4.mm-gap-3',
        stat({ label: 'Users', value: fmt.number(detail.usage.users), icon: 'users' }),
        stat({ label: 'Clients', value: fmt.number(detail.usage.clients), icon: 'building' }),
        stat({ label: 'Documents', value: fmt.number(detail.usage.documents), icon: 'files' }),
        stat({ label: 'Storage', value: fmt.bytes(detail.usage.storageBytes), icon: 'database' })),

      el('div.mm-kvgrid.mm-mt-4',
        kv('Status', fmt.label(detail.tenant.status)),
        kv('Plan', detail.subscription?.plan_name ?? 'None'),
        kv('Subscription', detail.subscription?.status ? fmt.label(detail.subscription.status) : null),
        kv('Renews', detail.subscription?.current_period_end ? fmt.date(detail.subscription.current_period_end) : null),
        kv('Franchise', detail.tenant.franchiseName),
        kv('State', detail.tenant.stateCode, { mono: true }),
        kv('Joined', fmt.date(detail.tenant.createdAt)),
        kv('Demo organisation', detail.tenant.isDemo ? 'Yes' : 'No')),

      (detail.owners ?? []).length
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Who runs it' }),
            el('ul.mm-list',
              ...detail.owners.map(owner => el('li.mm-list__row',
                el('div.mm-list__main',
                  el('span.mm-fw-medium', { text: owner.full_name }),
                  el('span.mm-muted.mm-text-xs', { text: owner.email })),
                owner.last_login_at
                  ? el('span.mm-muted.mm-text-xs', { text: `last in ${fmt.relative(owner.last_login_at)}` })
                  : pill('Never signed in', 'warning')))))
        : null,

      (detail.addOns ?? []).length
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: `Add-ons (${detail.addOns.length})` }),
            el('div.mm-row.mm-gap-1.mm-wrap',
              ...detail.addOns.map(addOn => pill(addOn.name, addOn.status === 'active' ? 'success' : 'neutral'))))
        : null,

      (detail.invoices ?? []).length
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Platform invoices' }),
            el('ul.mm-list',
              ...detail.invoices.slice(0, 5).map(invoice => el('li.mm-list__row',
                el('div.mm-list__main',
                  el('span.mm-fw-medium.mm-mono', { text: invoice.invoice_no }),
                  el('span.mm-muted.mm-text-xs', { text: fmt.date(invoice.issue_date) })),
                el('span.mm-numeric', { text: fmt.money(invoice.total_paise) }),
                statusPill(invoice.status)))))
        : null,

      el('div.mm-row.mm-gap-2.mm-mt-5',
        session.can('tenants.suspend')
          ? el('button.mm-btn.mm-btn--ghost.mm-btn--danger-text', {
              type: 'button',
              text: detail.tenant.status === 'suspended' ? 'Lift the suspension' : 'Suspend',
              onClick: () => close({ action: 'suspend' }),
            })
          : null,
        session.can('users.impersonate')
          ? el('button.mm-btn.mm-btn--ghost', {
              type: 'button', text: 'Open a support session', onClick: () => close({ action: 'impersonate' }),
            })
          : null,
        el('span.mm-grow'),
        el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) }),
        session.can('tenants.update')
          ? el('button.mm-btn.mm-btn--primary', {
              type: 'button', text: 'Change plan', onClick: () => close({ action: 'plan' }),
            })
          : null)),
  });

  if (!result) return;
  if (result.action === 'plan') return changePlan(detail.tenant, plans, table);
  if (result.action === 'suspend') return toggleSuspend(detail.tenant, table);
  if (result.action === 'impersonate') return impersonate(detail.tenant, detail.owners ?? []);
}

async function changePlan(tenant, plans, table) {
  const payload = await modal({
    title: `Change ${tenant.name}’s plan`,
    description: 'Existing records are never removed to fit a smaller plan; the new limits bite on the next create.',
    body: ({ close }) => {
      const plan = el('select.mm-select',
        ...plans.map(p => el('option', {
          value: p.key, selected: p.key === tenant.planKey, text: `${p.name} — ${p.monthlyPriceLabel ?? ''}`,
        })));
      const trialDays = el('input.mm-input', { type: 'number', min: '0', max: '90', value: '0' });
      const reason = el('textarea.mm-input.mm-textarea', { rows: '2', placeholder: 'Why is this changing?' });

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            planKey: plan.value,
            trialDays: Number(trialDays.value) || undefined,
            reason: reason.value.trim() || undefined,
          });
        },
      },
        el('div.mm-field', el('label.mm-field__label', { text: 'Plan' }), plan),
        el('div.mm-field',
          el('label.mm-field__label', { text: 'Trial days' }), trialDays,
          el('p.mm-field__hint', { text: 'Zero starts billing immediately.' })),
        el('div.mm-field', el('label.mm-field__label', { text: 'Reason' }), reason),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Change it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post(`/platform/tenants/${tenant.id}/plan`, payload);
    notify.success(`${tenant.name} is now on ${data.planName}.`);
    if (data.note) {
      notify.warning(data.note, { title: 'Over the new limits' });
    }
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}

async function toggleSuspend(tenant, table) {
  const suspending = tenant.status !== 'suspended';

  const reason = await promptText({
    title: suspending ? `Suspend ${tenant.name}?` : `Lift the suspension on ${tenant.name}?`,
    message: suspending
      ? 'Nobody in the organisation will be able to sign in. Their data is untouched.'
      : 'Everybody in the organisation will be able to sign in again.',
    label: 'Reason',
    placeholder: suspending ? 'Non-payment after three reminders.' : 'Account settled.',
    confirmLabel: suspending ? 'Suspend' : 'Lift it',
    tone: suspending ? 'danger' : 'primary',
  });
  if (!reason) return;

  try {
    await api.patch(`/platform/tenants/${tenant.id}`, {
      status: suspending ? 'suspended' : 'active',
      reason,
    });
    notify.success(suspending ? 'Suspended.' : 'Suspension lifted.');
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}

/**
 * Open a support session as a user of another organisation.
 *
 * Time-boxed, reason-bearing, and audited on both sides — in the platform
 * trail and in the organisation's own, so they can see that somebody from the
 * platform was in their account and why.
 */
async function impersonate(tenant, owners) {
  const payload = await modal({
    title: `Open a support session in ${tenant.name}`,
    description: 'They will see this in their own audit trail, with your name and your reason.',
    body: ({ close }) => {
      // A support session is opened *as* a specific person, never as a
      // disembodied administrator: their permissions are what bounds it.
      const userSelect = el('select.mm-select',
        ...owners.map(owner => el('option', {
          value: owner.id, text: `${owner.full_name} — ${owner.email}`,
        })));
      const reason = el('textarea.mm-input.mm-textarea', {
        rows: '3', placeholder: 'Investigating their report of a failed GSTR-1 export, ticket TKT-00042.',
      });
      const minutes = el('select.mm-select',
        ...[15, 30, 60].map(m => el('option', { value: String(m), selected: m === 30, text: `${m} minutes` })));
      const errorHost = el('div');

      if (!owners.length) {
        return frag(
          el('p', { text: 'This organisation has nobody to open a session as.' }),
          el('div.mm-row.mm-end.mm-mt-4',
            el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) })));
      }

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (reason.value.trim().length < 10) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'Say why, in enough detail that it means something to somebody reading it later.',
            }));
            return;
          }
          close({
            userId: userSelect.value,
            reason: reason.value.trim(),
            minutes: Number(minutes.value),
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Act as' }), userSelect),
        el('div.mm-field', el('label.mm-field__label', { text: 'Why are you going in?' }), reason),
        el('div.mm-field', el('label.mm-field__label', { text: 'For how long' }), minutes),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--danger', { type: 'submit', text: 'Open the session' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post(`/platform/tenants/${tenant.id}/impersonate`, payload);
    notify.warning(
      `You are now acting inside ${tenant.name} until ${fmt.dateTime(data.expiresAt)}.`,
      { title: 'Support session open', timeout: 0 });

    if (data.token) {
      const { setToken } = await import('../../core/api.js');
      setToken(data.token);
      await session.load();
      // A full reload, because every open screen is scoped to the previous
      // organisation and would otherwise show a mixture of the two.
      window.location.href = '/admin/dashboard';
    }
  } catch (err) {
    notifyError(err);
  }
}

async function createTenant(refresh) {
  const payload = await modal({
    title: 'Add an organisation',
    description: 'The owner receives an email with a link to set their password.',
    body: ({ close }) => {
      const name = el('input.mm-input', { placeholder: 'Meridian Tax Associates' });
      const ownerName = el('input.mm-input', { placeholder: 'Asha Menon' });
      const ownerEmail = el('input.mm-input', { type: 'email', placeholder: 'asha@meridiantax.example' });
      const ownerPhone = el('input.mm-input', { type: 'tel' });
      const gstin = el('input.mm-input', { maxlength: '15', style: { textTransform: 'uppercase' } });
      const planKey = el('select.mm-select',
        ...['basic', 'standard', 'pro', 'enterprise'].map(k => el('option', {
          value: k, selected: k === 'standard', text: fmt.label(k),
        })));
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim() || !ownerName.value.trim() || !ownerEmail.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'The organisation needs a name, and an owner with an email address.',
            }));
            return;
          }
          close({
            name: name.value.trim(),
            ownerName: ownerName.value.trim(),
            ownerEmail: ownerEmail.value.trim(),
            ownerPhone: ownerPhone.value.trim() || undefined,
            gstin: gstin.value.trim().toUpperCase() || undefined,
            planKey: planKey.value,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Organisation' }), name),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Owner' }), ownerName),
          el('div.mm-field', el('label.mm-field__label', { text: 'Their email' }), ownerEmail)),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Their phone' }), ownerPhone),
          el('div.mm-field', el('label.mm-field__label', { text: 'GSTIN' }), gstin),
          el('div.mm-field', el('label.mm-field__label', { text: 'Plan' }), planKey)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Create it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/platform/tenants', payload);
    notify.success(`${payload.name} created.`);
    if (data?.temporaryPassword) {
      notify.info(`One-time password for ${payload.ownerEmail}: ${data.temporaryPassword}`, {
        title: 'Pass this on now',
        timeout: 0,
      });
    }
    refresh();
  } catch (err) {
    notifyError(err);
  }
}
