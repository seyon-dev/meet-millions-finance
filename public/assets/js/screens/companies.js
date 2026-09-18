/**
 * Companies.
 *
 * The legal entities the practice files for. A client is a relationship; a
 * company is the registration a return is filed under, and one client can
 * have several. Keeping them apart is what makes multi-GSTIN clients work.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as session from '../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState,
  notify, notifyError, confirm, modal, banner,
} from '../core/ui.js';
import { dataTable, selectFilter } from '../components/table.js';
import { setBreadcrumbs } from '../layout/shell.js';

export default async function companiesScreen() {
  setBreadcrumbs([{ label: 'Companies' }]);

  const page = el('div.mm-page');
  let entityTypes = [];
  let stateCodes = [];

  const table = dataTable({
    searchPlaceholder: 'Search by name, GSTIN or PAN…',
    defaultSort: 'created_at',
    onRowClick: (row) => openCompany(row, { entityTypes, stateCodes }, table),
    filters: (apply, active) => [
      entityTypes.length
        ? selectFilter({
            label: 'Type',
            options: entityTypes.map(t => ({ value: t, label: fmt.label(t) })),
            value: active.entityType ?? '',
            onChange: v => apply('entityType', v),
          })
        : null,
      selectFilter({
        label: 'Status',
        options: ['active', 'inactive', 'closed'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
    ].filter(Boolean),
    load: async (params) => {
      const { data, meta } = await api.get('/companies', params);
      entityTypes = meta.entityTypes ?? entityTypes;
      stateCodes = meta.stateCodes ?? stateCodes;
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'name',
        label: 'Company',
        primary: true,
        render: row => el('div.mm-row.mm-gap-3',
          el('span.mm-filechip', icon('building', { size: 'sm' })),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: row.name }),
            el('span.mm-muted.mm-text-xs', {
              text: [fmt.label(row.entityType), row.branchName].filter(Boolean).join(' · '),
            }))),
      },
      {
        key: 'gstin',
        label: 'GSTIN',
        render: row => (row.gstin
          ? el('span.mm-mono.mm-text-xs', { text: row.gstin })
          : el('span.mm-c-warning.mm-text-xs', { text: 'Not registered' })),
      },
      { key: 'pan', label: 'PAN', hideOnMobile: true, render: row => (row.pan ? el('span.mm-mono.mm-text-xs', { text: row.pan }) : null) },
      {
        key: 'gstFilingFrequency',
        label: 'Filing',
        hideOnMobile: true,
        render: row => (row.gstFilingFrequency ? pill(row.gstFilingFrequency, 'neutral') : null),
      },
      {
        key: 'clientCount',
        label: 'Clients',
        align: 'center',
        hideOnMobile: true,
        render: row => el('span.mm-numeric', { text: String(row.clientCount ?? 0) }),
      },
      {
        key: 'documentCount',
        label: 'Documents',
        align: 'center',
        hideOnMobile: true,
        render: row => el('span.mm-numeric', { text: fmt.number(row.documentCount ?? 0) }),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
    ],
    empty: {
      title: 'No companies yet',
      message: 'A company is created with its first client, or added here for a client with more than one registration.',
      icon: 'building',
      action: session.can('companies.create')
        ? { label: 'Add a company', onClick: () => openCompany(null, { entityTypes, stateCodes }, table) }
        : null,
    },
  });

  page.append(
    pageHead({
      title: 'Companies',
      subtitle: 'The registrations your clients file under.',
      actions: session.can('companies.create')
        ? button('Add a company', {
            variant: 'primary', icon: 'plus',
            onClick: () => openCompany(null, { entityTypes, stateCodes }, table),
          })
        : null,
    }),
    card({ body: table.node, flush: true }));

  return page;
}

/**
 * One company, created or edited.
 *
 * The GSTIN drives the PAN and the state code, so both are derived from it as
 * it is typed and can still be corrected by hand.
 */
async function openCompany(existing, { entityTypes, stateCodes }, table) {
  const branches = await api.get('/branches').then(r => r.data ?? []).catch(() => []);
  const canEdit = existing ? session.can('companies.update') : session.can('companies.create');

  const result = await modal({
    title: existing ? existing.name : 'Add a company',
    description: existing ? [existing.gstin, fmt.label(existing.entityType)].filter(Boolean).join(' · ') : null,
    size: 'lg',
    body: ({ close }) => {
      const f = {};
      const input = (name, props = {}) => (f[name] = el('input.mm-input', {
        value: existing?.[name] ?? existing?.address?.[name] ?? '',
        disabled: !canEdit,
        ...props,
      }));

      const gstin = el('input.mm-input', {
        value: existing?.gstin ?? '',
        placeholder: '33AACCN5678K1Z3',
        maxlength: '15',
        disabled: !canEdit,
        style: { textTransform: 'uppercase' },
        onInput: (e) => {
          e.target.value = e.target.value.toUpperCase();
          const value = e.target.value;
          if (value.length >= 12 && !f.pan.value) f.pan.value = value.slice(2, 12);
          if (value.length >= 2 && !f.stateCode.value) f.stateCode.value = value.slice(0, 2);
        },
      });

      const entityType = el('select.mm-select', { disabled: !canEdit },
        ...(entityTypes.length ? entityTypes : ['private_limited']).map(t => el('option', {
          value: t, selected: t === existing?.entityType, text: fmt.label(t),
        })));

      const registration = el('select.mm-select', { disabled: !canEdit },
        ...['regular', 'composition', 'casual', 'non_resident', 'sez', 'unregistered'].map(t => el('option', {
          value: t, selected: t === existing?.gstRegistrationType, text: fmt.label(t),
        })));

      const frequency = el('select.mm-select', { disabled: !canEdit },
        ...['monthly', 'quarterly'].map(t => el('option', {
          value: t, selected: t === existing?.gstFilingFrequency, text: fmt.label(t),
        })));

      const branch = el('select.mm-select', { disabled: !canEdit },
        el('option', { value: '', text: 'No branch' }),
        ...branches.map(b => el('option', { value: b.id, selected: b.id === existing?.branchId, text: b.name })));

      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!f.name.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'The company needs a name.' }));
            return;
          }
          close({
            action: 'save',
            name: f.name.value.trim(),
            legalName: f.legalName.value.trim() || undefined,
            entityType: entityType.value,
            gstin: gstin.value.trim().toUpperCase() || undefined,
            pan: f.pan.value.trim().toUpperCase() || undefined,
            tan: f.tan.value.trim().toUpperCase() || undefined,
            cin: f.cin.value.trim().toUpperCase() || undefined,
            email: f.email.value.trim() || undefined,
            phone: f.phone.value.trim() || undefined,
            website: f.website.value.trim() || undefined,
            addressLine1: f.line1.value.trim() || undefined,
            city: f.city.value.trim() || undefined,
            state: f.state.value.trim() || undefined,
            stateCode: f.stateCode.value.trim() || undefined,
            pincode: f.pincode.value.trim() || undefined,
            branchId: branch.value || undefined,
            gstRegistrationType: registration.value,
            gstFilingFrequency: frequency.value,
          });
        },
      },
        errorHost,

        existing
          ? el('div.mm-grid.mm-grid-3.mm-gap-3.mm-mb-4',
              stat({ label: 'Clients', value: fmt.number(existing.clientCount ?? 0), icon: 'users' }),
              stat({ label: 'Documents', value: fmt.number(existing.documentCount ?? 0), icon: 'files' }),
              stat({ label: 'Added', value: fmt.date(existing.createdAt), icon: 'calendar' }))
          : null,

        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Trading name' }), input('name')),
          el('div.mm-field', el('label.mm-field__label', { text: 'Registered name' }), input('legalName'))),

        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Entity type' }), entityType),
          el('div.mm-field',
            el('label.mm-field__label', { text: 'GSTIN' }), gstin,
            el('p.mm-field__hint', { text: 'The PAN and state code are taken from it.' }))),

        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'PAN' }),
            input('pan', { maxlength: '10', style: { textTransform: 'uppercase' } })),
          el('div.mm-field', el('label.mm-field__label', { text: 'TAN' }),
            input('tan', { maxlength: '10', style: { textTransform: 'uppercase' } })),
          el('div.mm-field', el('label.mm-field__label', { text: 'CIN' }),
            input('cin', { maxlength: '21', style: { textTransform: 'uppercase' } }))),

        el('h3.mm-label.mm-mt-4', { text: 'How they file' }),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Registration' }), registration),
          el('div.mm-field', el('label.mm-field__label', { text: 'Frequency' }), frequency),
          el('div.mm-field', el('label.mm-field__label', { text: 'Branch' }), branch)),

        el('h3.mm-label.mm-mt-4', { text: 'Where they are' }),
        el('div.mm-field', el('label.mm-field__label', { text: 'Address' }), input('line1')),
        el('div.mm-grid.mm-grid-4.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'City' }), input('city')),
          el('div.mm-field', el('label.mm-field__label', { text: 'State' }), input('state')),
          el('div.mm-field', el('label.mm-field__label', { text: 'State code' }),
            input('stateCode', { maxlength: '2' })),
          el('div.mm-field', el('label.mm-field__label', { text: 'PIN' }), input('pincode', { maxlength: '6' }))),

        el('h3.mm-label.mm-mt-4', { text: 'How to reach them' }),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Email' }), input('email', { type: 'email' })),
          el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), input('phone', { type: 'tel' })),
          el('div.mm-field', el('label.mm-field__label', { text: 'Website' }), input('website'))),

        el('div.mm-row.mm-gap-2.mm-mt-5',
          existing && session.can('companies.delete')
            ? el('button.mm-btn.mm-btn--ghost.mm-btn--danger-text', {
                type: 'button', text: 'Archive', onClick: () => close({ action: 'delete' }),
              })
            : null,
          el('span.mm-grow'),
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) }),
          canEdit
            ? el('button.mm-btn.mm-btn--primary', { type: 'submit', text: existing ? 'Save' : 'Add it' })
            : null));
    },
  });

  if (!result) return;

  if (result.action === 'delete') {
    const answer = await confirm({
      title: `Archive ${existing.name}?`,
      message: 'It stops appearing in new work. Its documents, filings and history all stay.',
      confirmLabel: 'Archive',
      tone: 'danger',
    });
    if (!answer) return;
    try {
      await api.delete(`/companies/${existing.id}`);
      notify.success('Archived.');
      table.refresh();
    } catch (err) {
      notifyError(err);
    }
    return;
  }

  const { action, ...payload } = result;
  try {
    if (existing) await api.patch(`/companies/${existing.id}`, payload);
    else await api.post('/companies', payload);
    notify.success(existing ? 'Saved.' : `${payload.name} added.`);
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
