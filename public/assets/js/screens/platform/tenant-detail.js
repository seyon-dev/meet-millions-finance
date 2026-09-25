/**
 * One organisation, from the platform owner's chair.
 *
 * Deep-linkable — /platform/organisations/:id — because "look at Shaw Tax"
 * is a link somebody pastes into a support thread, not a modal that
 * evaporates. Everything the platform can know or do about one organisation
 * lives here: profile, subscription and its ledger, billing, people, recent
 * activity, and the controlled ways in — reminders, adjustments, payments,
 * suspension, support access.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, modal,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';
import { changePlan, toggleSuspend, impersonate } from './tenants.js';

const EVENT_ICONS = {
  plan_changed: 'refresh', period_extended: 'calendar', trial_extended: 'clock',
  status_changed: 'activity', payment_recorded: 'credit-card', reminder_sent: 'send',
  renewed: 'refresh', suspended: 'lock', reactivated: 'unlock', note: 'file-text',
};
const EVENT_TONES = {
  payment_recorded: 'mm-timeline__dot--success', renewed: 'mm-timeline__dot--success',
  reactivated: 'mm-timeline__dot--success', suspended: 'mm-timeline__dot--danger',
  reminder_sent: 'mm-timeline__dot--warning', plan_changed: 'mm-timeline__dot--brand',
};

const EVENT_LABELS = {
  plan_changed: 'Plan changed',
  period_extended: 'Period extended',
  trial_extended: 'Trial adjusted',
  status_changed: 'Status changed',
  payment_recorded: 'Payment recorded',
  reminder_sent: 'Notice sent',
  renewed: 'Renewed',
  suspended: 'Suspended',
  reactivated: 'Reactivated',
  note: 'Note',
};

export default async function tenantDetailScreen({ params }) {
  const page = el('div.mm-page');
  const body = el('div');
  page.append(body);

  const plans = await api.get('/platform/plans').then(r => r.data?.plans ?? []).catch(() => []);
  const refresh = { refresh: () => paint() };

  async function paint() {
    let detail;
    try {
      ({ data: detail } = await api.get(`/platform/tenants/${params.id}`));
    } catch (err) {
      render(body, errorState(err, { onRetry: paint }));
      return;
    }

    const t = detail.tenant;
    const sub = detail.subscription;
    setBreadcrumbs([
      { label: 'Platform' },
      { label: 'Organisations', href: '/platform/organisations' },
      { label: t.name },
    ]);

    const actions = el('div.mm-row.mm-gap-2.mm-wrap',
      session.can('tenants.update')
        ? button('Edit', { icon: 'edit', onClick: () => editTenant(t, refresh) }) : null,
      session.can('tenants.update')
        ? button('Send a notice', { icon: 'send', onClick: () => sendNotice(t, refresh) }) : null,
      session.can('users.impersonate')
        ? button('Support access', { icon: 'shield', onClick: () => impersonate(t, detail.owners ?? []) }) : null,
      session.can('tenants.suspend')
        ? button(t.status === 'suspended' ? 'Lift suspension' : 'Suspend', {
            variant: t.status === 'suspended' ? 'secondary' : 'ghost',
            icon: t.status === 'suspended' ? 'unlock' : 'lock',
            onClick: () => toggleSuspend(t, refresh),
          }) : null,
    );

    render(body, frag(
      pageHead({
        title: t.name,
        subtitle: [t.legalName, t.email].filter(Boolean).join(' · ') || null,
        actions,
      }),

      t.status !== 'active'
        ? el('div.mm-mb-4', el('div.mm-banner.mm-banner--danger',
            el('span', { text: `This organisation is ${fmt.label(t.status).toLowerCase()}. Its own people cannot sign in; platform support access still can.` })))
        : null,

      el('div.mm-grid.mm-grid-4.mm-gap-4.mm-mb-5',
        stat({ label: 'Users', value: fmt.number(detail.usage.users), icon: 'users' }),
        stat({ label: 'Clients', value: fmt.number(detail.usage.clients), icon: 'building' }),
        stat({ label: 'Documents', value: fmt.number(detail.usage.documents), icon: 'files' }),
        stat({ label: 'Storage', value: fmt.bytes(detail.usage.storageBytes), icon: 'database' })),

      el('div.mm-grid.mm-grid-2.mm-gap-5.mm-align-start',
        el('div.mm-stack.mm-gap-5',
          subscriptionCard(t, sub, plans, detail, refresh),
          invoicesCard(t, detail, refresh),
          ledgerCard(detail)),
        el('div.mm-stack.mm-gap-5',
          profileCard(t),
          peopleCard(detail),
          activityCard(detail))),
    ));
  }

  await paint();
  return page;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function subscriptionCard(t, sub, plans, detail, refresh) {
  const state = sub?.status ?? null;
  const inGrace = sub?.grace_until && new Date(sub.grace_until) > new Date();

  return card({
    title: 'Subscription',
    actions: el('div.mm-row.mm-gap-2',
      session.can('tenants.update')
        ? button('Change plan', { size: 'sm', onClick: () => changePlan(t, plans, refresh) }) : null,
      session.can('tenants.update')
        ? button('Adjust', { size: 'sm', variant: 'ghost', onClick: () => adjustSubscription(t, sub, refresh) }) : null),
    body: sub
      ? el('div.mm-kvgrid',
          kv('Plan', sub.plan_name),
          kv('State', fmt.label(state ?? 'none')),
          kv('Billing cycle', fmt.label(sub.billing_cycle ?? 'monthly')),
          kv('Current period ends', sub.current_period_end ? fmt.date(sub.current_period_end) : null),
          sub.trial_ends_at ? kv('Trial ends', fmt.date(sub.trial_ends_at)) : null,
          inGrace ? kv('Grace until', fmt.date(sub.grace_until)) : null,
          kv('Auto-renew', sub.auto_renew ? 'Yes' : 'No'))
      : emptyState({ title: 'No subscription', message: 'This organisation has no subscription on record.', inline: true }),
  });
}

function invoicesCard(t, detail, refresh) {
  const invoices = detail.invoices ?? [];
  return card({
    title: 'Platform billing',
    actions: session.can('tenants.update')
      ? button('Record a payment', { size: 'sm', onClick: () => recordPayment(t, invoices, refresh) })
      : null,
    body: invoices.length
      ? el('ul.mm-list',
          ...invoices.map(invoice => el('li.mm-list__row',
            el('div.mm-list__main',
              el('span.mm-fw-medium.mm-mono', { text: invoice.invoice_no }),
              el('span.mm-muted.mm-text-xs', { text: `issued ${fmt.date(invoice.issue_date)} · due ${fmt.date(invoice.due_date)}` })),
            el('span.mm-numeric', { text: fmt.money(invoice.total_paise) }),
            Number(invoice.amount_due_paise) > 0
              ? el('span.mm-muted.mm-text-xs.mm-numeric', { text: `${fmt.money(invoice.amount_due_paise)} due` })
              : null,
            statusPill(invoice.status))))
      : emptyState({ title: 'No invoices', message: 'No platform invoices have been raised for this organisation.', inline: true }),
  });
}

function ledgerCard(detail) {
  const events = detail.events ?? [];
  return card({
    title: 'Subscription history',
    subtitle: 'Every change, reminder and payment — kept beyond audit retention.',
    body: events.length
      ? el('div.mm-timeline',
          ...events.map(event => el('div.mm-timeline__item',
            el('div', { class: `mm-timeline__dot ${EVENT_TONES[event.kind] ?? ''}` },
              icon(EVENT_ICONS[event.kind] ?? 'clock')),
            el('div.mm-timeline__body',
              el('div.mm-timeline__title',
                el('span.mm-fw-medium', { text: EVENT_LABELS[event.kind] ?? fmt.label(event.kind) })),
              el('div.mm-timeline__meta',
                describeEvent(event),
                event.actorName ? el('span', { text: `by ${event.actorName}` }) : null,
                el('span', { text: fmt.relative(event.createdAt) }))))))
      : emptyState({ title: 'Nothing yet', message: 'Plan changes, reminders and payments will appear here.', inline: true }),
  });
}

function describeEvent(event) {
  const v = event.newValue ?? {};
  let text = null;
  if (event.kind === 'plan_changed') text = `to ${v.plan ?? '?'}${event.oldValue?.plan ? ` (from ${event.oldValue.plan})` : ''}`;
  else if (event.kind === 'period_extended') text = v.currentPeriodEnd ? `until ${fmt.date(v.currentPeriodEnd)}` : null;
  else if (event.kind === 'trial_extended') text = v.trialEndsAt ? `trial until ${fmt.date(v.trialEndsAt)}` : null;
  else if (event.kind === 'status_changed') text = [event.oldValue?.status, v.status].filter(Boolean).join(' → ') || null;
  else if (event.kind === 'payment_recorded') text = `${fmt.money(v.amountPaise ?? 0)} · ${fmt.label(v.method ?? '')} · ${v.reference ?? ''}`;
  else if (event.kind === 'reminder_sent') text = `${fmt.label(v.kind ?? 'notice')} to ${v.recipients ?? '?'} administrator(s)`;
  else if (event.kind === 'renewed') text = v.currentPeriodEnd ? `next period ends ${fmt.date(v.currentPeriodEnd)}` : null;
  return frag(
    text ? el('span.mm-text-sm', { text }) : null,
    event.note ? el('span.mm-muted.mm-text-xs', { text: event.note }) : null);
}

function profileCard(t) {
  return card({
    title: 'Profile',
    body: el('div.mm-kvgrid',
      kv('Status', fmt.label(t.status)),
      kv('GSTIN', t.gstin, { mono: true }),
      kv('PAN', t.pan, { mono: true }),
      kv('TAN', t.tan, { mono: true }),
      kv('Email', t.email),
      kv('Phone', t.phone),
      kv('Address', [t.addressLine1, t.addressLine2, t.city, t.state, t.pincode].filter(Boolean).join(', ') || null),
      kv('State code', t.stateCode, { mono: true }),
      kv('Timezone', t.timezone),
      kv('Franchise', t.franchiseName),
      kv('Joined', fmt.date(t.createdAt)),
      kv('Last activity', t.lastActivityAt ? fmt.relative(t.lastActivityAt) : 'Never'),
      kv('Demo organisation', t.isDemo ? 'Yes' : 'No')),
  });
}

function peopleCard(detail) {
  const users = detail.users ?? [];
  return card({
    title: `People (${users.length})`,
    body: users.length
      ? el('ul.mm-list',
          ...users.slice(0, 12).map(user => el('li.mm-list__row',
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: user.fullName }),
              el('span.mm-muted.mm-text-xs', { text: [user.email, user.roleName].filter(Boolean).join(' · ') })),
            user.status !== 'active' ? pill(fmt.label(user.status), 'warning') : null,
            el('span.mm-muted.mm-text-xs', {
              text: user.lastLoginAt ? `last in ${fmt.relative(user.lastLoginAt)}` : 'never signed in',
            }))),
          users.length > 12
            ? el('li.mm-list__row', el('span.mm-muted.mm-text-xs', { text: `and ${users.length - 12} more` }))
            : null)
      : emptyState({ title: 'Nobody yet', message: 'No accounts exist in this organisation.', inline: true }),
  });
}

function activityCard(detail) {
  const activity = detail.activity ?? [];
  return card({
    title: 'Recent activity',
    subtitle: 'From the organisation’s own audit trail.',
    body: activity.length
      ? el('ul.mm-list',
          ...activity.map(entry => el('li.mm-list__row',
            el('div.mm-list__main',
              el('span.mm-text-sm', { text: fmt.label(entry.action?.split('.').pop() ?? entry.action) }),
              el('span.mm-muted.mm-text-xs', {
                text: [entry.actor_name, entry.entity_label].filter(Boolean).join(' · '),
              })),
            el('span.mm-muted.mm-text-xs', { text: fmt.relative(entry.created_at) }))))
      : emptyState({ title: 'Quiet', message: 'No audited activity yet.', inline: true }),
  });
}

// ---------------------------------------------------------------------------
// Actions the list screen does not have
// ---------------------------------------------------------------------------

async function editTenant(t, refresh) {
  const payload = await modal({
    title: `Edit ${t.name}`,
    body: ({ close }) => {
      const f = {
        name: el('input.mm-input', { value: t.name ?? '' }),
        legalName: el('input.mm-input', { value: t.legalName ?? '' }),
        email: el('input.mm-input', { type: 'email', value: t.email ?? '' }),
        phone: el('input.mm-input', { type: 'tel', value: t.phone ?? '' }),
        gstin: el('input.mm-input', { value: t.gstin ?? '', maxlength: '15', style: { textTransform: 'uppercase' } }),
        pan: el('input.mm-input', { value: t.pan ?? '', maxlength: '10', style: { textTransform: 'uppercase' } }),
        tan: el('input.mm-input', { value: t.tan ?? '', maxlength: '10', style: { textTransform: 'uppercase' } }),
        addressLine1: el('input.mm-input', { value: t.addressLine1 ?? '' }),
        city: el('input.mm-input', { value: t.city ?? '' }),
        pincode: el('input.mm-input', { value: t.pincode ?? '', maxlength: '10' }),
      };
      const field = (label, input) => el('div.mm-field', el('label.mm-field__label', { text: label }), input);
      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const out = {};
          for (const [key, input] of Object.entries(f)) {
            const value = input.value.trim();
            if (value !== String(t[key] ?? '')) out[key] = value || undefined;
          }
          close(Object.keys(out).length ? out : null);
        },
      },
        field('Name', f.name), field('Legal name', f.legalName),
        el('div.mm-grid.mm-grid-2.mm-gap-3', field('Email', f.email), field('Phone', f.phone)),
        el('div.mm-grid.mm-grid-3.mm-gap-3', field('GSTIN', f.gstin), field('PAN', f.pan), field('TAN', f.tan)),
        field('Address', f.addressLine1),
        el('div.mm-grid.mm-grid-2.mm-gap-3', field('City', f.city), field('PIN code', f.pincode)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!payload) return;
  try {
    await api.patch(`/platform/tenants/${t.id}`, payload);
    notify.success('Saved.');
    refresh.refresh();
  } catch (err) { notifyError(err); }
}

async function adjustSubscription(t, sub, refresh) {
  const payload = await modal({
    title: `Adjust ${t.name}’s subscription`,
    description: 'Every change here lands in the subscription history with your name on it.',
    body: ({ close }) => {
      const extendDays = el('input.mm-input', { type: 'number', min: '0', max: '366', value: '0' });
      const status = el('select.mm-select',
        el('option', { value: '', text: `Keep ${fmt.label(sub?.status ?? 'active')}` }),
        ...['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired']
          .map(v => el('option', { value: v, text: fmt.label(v) })));
      const graceDays = el('input.mm-input', { type: 'number', min: '0', max: '90', placeholder: 'unchanged' });
      const note = el('textarea.mm-input.mm-textarea', { rows: '2', placeholder: 'Why?' });
      const field = (label, input, hint) => el('div.mm-field',
        el('label.mm-field__label', { text: label }), input,
        hint ? el('p.mm-field__hint', { text: hint }) : null);
      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const out = { note: note.value.trim() || undefined };
          if (Number(extendDays.value) > 0) out.extendDays = Number(extendDays.value);
          if (status.value) out.status = status.value;
          if (graceDays.value !== '') out.graceDays = Number(graceDays.value);
          if (!out.extendDays && !out.status && out.graceDays === undefined) { close(null); return; }
          close(out);
        },
      },
        field('Extend the period by (days)', extendDays, 'Extends from the current period end, or from today if it already passed.'),
        field('Move to state', status),
        field('Grace window (days)', graceDays, 'How long past_due may last before it expires. Zero clears it.'),
        field('Note', note),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Apply' })));
    },
  });
  if (!payload) return;
  try {
    await api.patch(`/platform/tenants/${t.id}/subscription`, payload);
    notify.success('Subscription adjusted.');
    refresh.refresh();
  } catch (err) { notifyError(err); }
}

async function recordPayment(t, invoices, refresh) {
  const open = invoices.filter(i => Number(i.amount_due_paise) > 0);
  const payload = await modal({
    title: `Record a payment from ${t.name}`,
    description: 'For money that arrived outside a gateway — a bank transfer, a cheque.',
    body: ({ close }) => {
      const amount = el('input.mm-input', { type: 'number', min: '1', step: '0.01', placeholder: '0.00' });
      const method = el('select.mm-select',
        ...['bank_transfer', 'upi', 'cheque', 'cash', 'net_banking']
          .map(m => el('option', { value: m, text: fmt.label(m) })));
      const reference = el('input.mm-input', { placeholder: 'NEFT / UTR / cheque number' });
      const invoice = el('select.mm-select',
        el('option', { value: '', text: 'No specific invoice' }),
        ...open.map(i => el('option', {
          value: i.id, text: `${i.invoice_no} — ${fmt.money(i.amount_due_paise)} due`,
        })));
      const note = el('textarea.mm-input.mm-textarea', { rows: '2' });
      const errorHost = el('div');
      const field = (label, input) => el('div.mm-field', el('label.mm-field__label', { text: label }), input);
      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const rupees = Number(amount.value);
          if (!rupees || rupees <= 0) {
            render(errorHost, el('p.mm-field__error', { role: 'alert', text: 'Enter the amount received.' }));
            return;
          }
          close({
            amountPaise: Math.round(rupees * 100),
            method: method.value,
            reference: reference.value.trim() || undefined,
            invoiceId: invoice.value || undefined,
            note: note.value.trim() || undefined,
          });
        },
      },
        errorHost,
        field('Amount (₹)', amount),
        el('div.mm-grid.mm-grid-2.mm-gap-3', field('Method', method), field('Reference', reference)),
        open.length ? field('Settles invoice', invoice) : null,
        field('Note', note),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Record it' })));
    },
  });
  if (!payload) return;
  try {
    await api.post(`/platform/tenants/${t.id}/payments`, payload);
    notify.success('Payment recorded.');
    refresh.refresh();
  } catch (err) { notifyError(err); }
}

async function sendNotice(t, refresh) {
  const payload = await modal({
    title: `Send a notice to ${t.name}`,
    description: 'Lands in their administrators’ notification centre, and goes out by email where email is configured.',
    body: ({ close }) => {
      const kind = el('select.mm-select',
        el('option', { value: 'payment_reminder', text: 'Payment reminder' }),
        el('option', { value: 'renewal_reminder', text: 'Renewal reminder' }),
        el('option', { value: 'trial_reminder', text: 'Trial ending reminder' }),
        el('option', { value: 'suspension_warning', text: 'Suspension warning' }),
        el('option', { value: 'announcement', text: 'Announcement' }));
      const subject = el('input.mm-input', { placeholder: 'Only used for announcements', maxlength: '160' });
      const message = el('textarea.mm-input.mm-textarea', { rows: '4', placeholder: 'What should they know?' });
      const errorHost = el('div');
      const field = (label, input) => el('div.mm-field', el('label.mm-field__label', { text: label }), input);
      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (kind.value === 'announcement' && !message.value.trim()) {
            render(errorHost, el('p.mm-field__error', { role: 'alert', text: 'An announcement needs a message.' }));
            return;
          }
          close({
            kind: kind.value,
            subject: subject.value.trim() || undefined,
            message: message.value.trim() || undefined,
          });
        },
      },
        errorHost,
        field('Kind', kind),
        field('Subject', subject),
        field('Message', message),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send it' })));
    },
  });
  if (!payload) return;
  try {
    const { data } = await api.post(`/platform/tenants/${t.id}/notify`, payload);
    notify.success(`Sent to ${data.recipients} administrator${data.recipients === 1 ? '' : 's'}.`);
    refresh.refresh();
  } catch (err) { notifyError(err); }
}
