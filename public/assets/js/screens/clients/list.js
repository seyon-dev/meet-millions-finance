/**
 * The client list.
 *
 * The screen a practice lives on. Sorting, filtering and paging are all in the
 * URL, so a filtered view is a link somebody can send to a colleague rather
 * than a set of instructions.
 */

import { el, frag } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import * as fmt from '../../core/format.js';
import {
  pageHead, card, button, statusPill, pill, avatar, notify, notifyError, modal, emptyState,
} from '../../core/ui.js';
import { dataTable, selectFilter } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function clientsScreen({ query }) {
  setBreadcrumbs([{ label: 'Clients' }]);

  const page = el('div.mm-page');
  let table;

  const statuses = ['active', 'onboarding', 'paused', 'archived'];

  table = dataTable({
    searchPlaceholder: 'Search by name, code, GSTIN or contact…',
    defaultSort: 'created_at',
    load: async (params) => {
      const { data, meta } = await api.get('/clients', params);
      return { rows: data ?? [], meta };
    },
    onRowClick: (row) => router.go(`/clients/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'Status',
        options: statuses.map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
      session.can('clients.view')
        ? selectFilter({
            label: 'Assigned',
            options: [{ value: 'me', label: 'Assigned to me' }],
            value: active.assignedTo ?? '',
            onChange: v => apply('assignedTo', v === 'me' ? session.session().user.id : null),
            allLabel: 'Anyone',
          })
        : null,
    ].filter(Boolean),
    toolbar: () => [
      button('Export', {
        variant: 'ghost', icon: 'download',
        onClick: () => api.download('/clients/export/csv', { fileName: 'clients.csv' })
          .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
          .catch(notifyError),
      }),
    ],
    columns: [
      {
        key: 'displayName',
        label: 'Client',
        primary: true,
        sortable: true,
        render: row => el('div.mm-row.mm-gap-3',
          avatar(row.displayName, { size: 'sm' }),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: row.displayName }),
            el('span.mm-muted.mm-text-xs', { text: row.clientCode ?? '' }))),
      },
      {
        key: 'gstin',
        label: 'GSTIN',
        hideOnMobile: true,
        render: row => (row.company?.gstin
          ? el('span.mm-mono.mm-text-xs', { text: row.company.gstin })
          : null),
      },
      {
        key: 'currentPeriod',
        label: 'This month',
        render: row => (row.currentPeriod
          ? el('div.mm-stack',
              el('span.mm-text-xs', {
                text: `${row.currentPeriod.documentsVerified ?? 0}/${row.currentPeriod.documentsExpected ?? 0} verified`,
              }),
              el('span.mm-progress.mm-progress--sm',
                el('span.mm-progress__bar', {
                  class: row.currentPeriod.status === 'filed' ? 'mm-progress__bar--success' : '',
                  style: { width: `${progressOf(row.currentPeriod)}%` },
                })))
          : el('span.mm-muted.mm-text-xs', { text: 'No open period' })),
      },
      {
        key: 'openQueries',
        label: 'Queries',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.openQueries
          ? pill(String(row.openQueries), 'warning')
          : el('span.mm-muted', { text: '—' })),
      },
      {
        key: 'assignedExecutiveName',
        label: 'Executive',
        hideOnMobile: true,
        render: row => (row.assignedExecutiveName
          ? el('span.mm-text-sm', { text: row.assignedExecutiveName })
          : el('span.mm-muted.mm-text-xs', { text: 'Unassigned' })),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
    ],
    empty: {
      title: 'No clients yet',
      message: 'Add your first client and their filing month opens automatically.',
      icon: 'users',
      action: session.can('clients.create') ? { label: 'Add a client', onClick: () => openNewClient(table) } : null,
    },
  });

  page.append(
    pageHead({
      title: 'Clients',
      subtitle: 'Every company you file for, and where their month stands.',
      actions: session.can('clients.create')
        ? button('Add client', { variant: 'primary', icon: 'user-plus', onClick: () => openNewClient(table) })
        : null,
    }),
    card({ body: table.node, flush: true }));

  // ?new=1 opens the form directly, so the dashboard's "New client" button is
  // a single click rather than a navigation followed by another click.
  if (query.get('new')) queueMicrotask(() => openNewClient(table));

  return page;
}

function progressOf(period) {
  const expected = period.documentsExpected ?? 0;
  if (!expected) return 0;
  return Math.min(100, Math.round(((period.documentsVerified ?? 0) / expected) * 100));
}

/**
 * Onboard a client.
 *
 * The GSTIN drives three other fields — PAN, state and the filing calendar —
 * so it is asked for first and the rest are filled from it.
 */
async function openNewClient(table) {
  const result = await modal({
    title: 'Add a client',
    description: 'Their first filing month opens as soon as they are created.',
    size: 'lg',
    body: ({ close }) => {
      const errorHost = el('div');
      const f = {};
      const input = (name, props) => (f[name] = el('input.mm-input', props));

      const gstin = input('gstin', {
        placeholder: '33AACCN5678K1Z3', maxlength: '15',
        style: { textTransform: 'uppercase' },
        onInput: (e) => {
          e.target.value = e.target.value.toUpperCase();
          if (e.target.value.length >= 12 && !f.pan.value) {
            f.pan.value = e.target.value.slice(2, 12);
          }
        },
      });

      const form = el('form.mm-form', {
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          const payload = {
            displayName: f.displayName.value.trim(),
            companyName: f.companyName.value.trim() || f.displayName.value.trim(),
            gstin: gstin.value.trim() || undefined,
            pan: f.pan.value.trim() || undefined,
            contactName: f.contactName.value.trim(),
            contactEmail: f.contactEmail.value.trim() || undefined,
            contactPhone: f.contactPhone.value.trim() || undefined,
            createPortalLogin: f.portal.checked,
            openCurrentPeriod: f.period.checked,
          };

          if (!payload.displayName) {
            errorHost.replaceChildren(fieldError('Give the client a name.'));
            return;
          }
          if (!payload.contactName) {
            errorHost.replaceChildren(fieldError('Name the person you deal with.'));
            return;
          }
          if (payload.createPortalLogin && !payload.contactEmail) {
            errorHost.replaceChildren(fieldError('A portal login needs the contact’s email address.'));
            return;
          }

          const submitButton = form.querySelector('button[type=submit]');
          submitButton.disabled = true;
          submitButton.textContent = 'Creating…';

          try {
            const { data } = await api.post('/clients', payload);
            close(data);
          } catch (err) {
            errorHost.replaceChildren(fieldError(
              err.name === 'ValidationError'
                ? Object.values(err.fields ?? {})[0] ?? err.message
                : err.message));
            submitButton.disabled = false;
            submitButton.textContent = 'Create client';
          }
        },
      },
        errorHost,
        el('div.mm-grid.mm-grid-2.mm-gap-4',
          labelled('Client name', input('displayName', { placeholder: 'Radiant Traders', required: true })),
          labelled('Registered company name', input('companyName', { placeholder: 'Radiant Traders Private Limited' })),
          labelled('GSTIN', gstin, 'The PAN and state are taken from this.'),
          labelled('PAN', input('pan', { placeholder: 'AACCN5678K', maxlength: '10', style: { textTransform: 'uppercase' } }))),

        el('h3.mm-label.mm-mt-5', { text: 'Who you deal with' }),
        el('div.mm-grid.mm-grid-3.mm-gap-4',
          labelled('Contact name', input('contactName', { placeholder: 'Priya Sharma', required: true })),
          labelled('Email', input('contactEmail', { type: 'email', placeholder: 'priya@radianttraders.example' })),
          labelled('Mobile', input('contactPhone', { type: 'tel', placeholder: '98450 12233' }))),

        el('div.mm-stack.mm-gap-2.mm-mt-5',
          checkbox('portal', f, 'Create a portal login for them', true,
            'They get a one-time password to upload documents themselves.'),
          checkbox('period', f, 'Open this month’s filing period', true,
            'Creates the checklist for the current month.')),

        el('div.mm-row.mm-end.mm-gap-2.mm-mt-5',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Create client' })));

      return form;
    },
  });

  if (!result) return;
  table.refresh();

  // The one-time password is shown once, here, and never again.
  if (result.temporaryPassword) {
    await modal({
      title: 'Client created',
      size: 'sm',
      body: ({ close }) => frag(
        el('p', { text: `${result.client.displayName} is set up, and a portal login was created for ${result.portalUser.email}.` }),
        el('div.mm-banner.mm-banner--warning.mm-mt-4',
          el('span.mm-banner__icon', icon('key', { size: 'sm' })),
          el('div',
            el('p.mm-fw-medium', { text: 'One-time password' }),
            el('p.mm-mono.mm-text-lg', { text: result.temporaryPassword }),
            el('p.mm-text-xs', { text: 'Pass this on now. It cannot be shown again, and they must change it on first sign-in.' }))),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-5',
          el('button.mm-btn.mm-btn--ghost', {
            type: 'button', text: 'Copy password',
            onClick: () => {
              navigator.clipboard?.writeText(result.temporaryPassword);
              notify.success('Copied.');
            },
          }),
          el('a.mm-btn.mm-btn--primary', {
            href: `/clients/${result.client.id}`,
            text: 'Open client',
            onClick: () => close(null),
          }))),
    });
  } else {
    notify.success(`${result.client.displayName} added.`);
  }
}

function labelled(label, input, hint = null) {
  return el('div.mm-field',
    el('label.mm-field__label', { text: label }),
    input,
    hint ? el('p.mm-field__hint', { text: hint }) : null);
}

function checkbox(name, store, label, checked, hint) {
  const input = el('input.mm-checkbox', { type: 'checkbox', checked });
  store[name] = input;
  return el('label.mm-switch',
    input,
    el('span.mm-switch__text',
      el('span', { text: label }),
      hint ? el('span.mm-muted.mm-text-xs.mm-block', { text: hint }) : null));
}

function fieldError(message) {
  return el('div.mm-banner.mm-banner--danger', { role: 'alert' },
    el('span.mm-banner__icon', icon('alert', { size: 'sm' })),
    el('p', { text: message }));
}
