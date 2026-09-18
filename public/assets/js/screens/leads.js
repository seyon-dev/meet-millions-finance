/**
 * Leads.
 *
 * Enquiries from every source in one pipeline, with conversion as the point of
 * the screen. A lead that converts becomes a client record and stops being a
 * lead — which is why "Convert" is the primary action on a qualified one.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as router from '../core/router.js';
import * as session from '../core/session.js';
import {
  pageHead, card, stat, kv, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, confirm, modal, lockedState, banner,
} from '../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../components/table.js';
import { setBreadcrumbs } from '../layout/shell.js';

const STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];

export default async function leadsScreen({ query }) {
  setBreadcrumbs([{ label: 'Leads' }]);

  const page = el('div.mm-page');
  const pipelineHost = el('div');
  const tabHost = el('div');

  let activeTab = query.get('status') ?? 'all';

  const table = dataTable({
    searchPlaceholder: 'Search by name, company, email or phone…',
    defaultSort: 'created_at',
    onRowClick: (row) => openLead(row, table),
    filters: (apply, active) => [
      selectFilter({
        label: 'Source',
        options: ['website_form', 'meta_ads', 'google_form', 'sheet', 'whatsapp', 'call', 'referral', 'manual', 'api']
          .map(s => ({ value: s, label: fmt.label(s) })),
        value: active.source ?? '',
        onChange: v => apply('source', v),
      }),
      selectFilter({
        label: 'Assigned',
        options: [{ value: session.session().user?.id ?? '', label: 'To me' }],
        value: active.assignedTo ?? '',
        allLabel: 'Anyone',
        onChange: v => apply('assignedTo', v),
      }),
    ],
    load: async (params) => {
      const { data, meta } = await api.get('/leads', {
        status: activeTab === 'all' ? undefined : activeTab,
        ...params,
      });
      paintPipeline(meta);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'fullName',
        label: 'Lead',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.fullName }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.companyName, row.city].filter(Boolean).join(' · '),
          })),
      },
      {
        key: 'contact',
        label: 'Contact',
        hideOnMobile: true,
        render: row => el('div.mm-stack',
          row.email ? el('span.mm-text-xs', { text: row.email }) : null,
          row.phone ? el('span.mm-muted.mm-text-xs', { text: row.phone }) : null),
      },
      {
        key: 'source',
        label: 'Source',
        hideOnMobile: true,
        render: row => pill(row.source, 'neutral'),
      },
      {
        key: 'score',
        label: 'Score',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.score
          ? el('span.mm-numeric', {
              class: row.score >= 70 ? 'mm-c-success' : row.score >= 40 ? '' : 'mm-muted',
              text: String(row.score),
            })
          : null),
      },
      {
        key: 'ownerName',
        label: 'Owner',
        hideOnMobile: true,
        render: row => (row.ownerName
          ? el('span.mm-text-sm', { text: row.ownerName })
          : el('span.mm-muted.mm-text-xs', { text: 'Unassigned' })),
      },
      { key: 'status', label: 'Stage', render: row => statusPill(row.status) },
      { key: 'createdAt', label: 'Received', format: 'relative' },
    ],
    empty: {
      title: 'No leads in this stage',
      message: 'Leads arrive from Meta lead ads, website forms, Google Forms and referrals — or you can add one by hand.',
      icon: 'magnet',
    },
  });

  function paintPipeline(meta) {
    const pipeline = meta.pipeline ?? {};
    const total = Object.values(pipeline).reduce((n, v) => n + v, 0);

    render(pipelineHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'New', value: fmt.number(pipeline.new ?? 0), icon: 'magnet', tone: pipeline.new ? 'warning' : null }),
      stat({ label: 'In conversation', value: fmt.number((pipeline.contacted ?? 0) + (pipeline.qualified ?? 0)), icon: 'message-circle' }),
      stat({ label: 'Won', value: fmt.number(pipeline.won ?? 0), icon: 'check-circle', tone: 'success' }),
      stat({
        label: 'Conversion',
        value: total ? fmt.percent(((pipeline.won ?? 0) / total) * 100, { decimals: 1 }) : '—',
        caption: `${fmt.plural(total, 'lead')} in total`,
        icon: 'trending-up',
      })));
  }

  function paintTabs() {
    render(tabHost, tabStrip({
      tabs: [{ key: 'all', label: 'All' }, ...STAGES.map(s => ({ key: s, label: fmt.label(s) }))]
        .map(t => ({ ...t, count: null })),
      active: activeTab,
      onChange: (key) => {
        activeTab = key;
        router.setQuery({ status: key === 'all' ? null : key });
        table.state.page = 1;
        table.refresh();
        paintTabs();
      },
    }));
  }

  paintTabs();

  page.append(
    pageHead({
      title: 'Leads',
      subtitle: 'Every enquiry, from every source, in one pipeline.',
      actions: session.can('leads.manage')
        ? button('Add a lead', { variant: 'primary', icon: 'plus', onClick: () => addLead(table) })
        : null,
    }),
    pipelineHost,
    tabHost,
    card({ body: table.node, flush: true }));

  return page;
}

/** One lead, with its stage, its origin and the action that ends it. */
async function openLead(lead, table) {
  const result = await modal({
    title: lead.fullName,
    description: [lead.companyName, lead.city].filter(Boolean).join(' · ') || null,
    size: 'lg',
    body: ({ close }) => {
      const status = el('select.mm-select',
        ...STAGES.map(s => el('option', { value: s, selected: s === lead.status, text: fmt.label(s) })));

      return frag(
        lead.convertedClientId
          ? banner({
              text: `Converted to ${lead.convertedClientName ?? 'a client'} on ${fmt.date(lead.convertedAt)}.`,
              tone: 'success',
              icon: 'check-circle',
              action: { label: 'Open the client', href: `/clients/${lead.convertedClientId}` },
            })
          : null,

        lead.message ? el('p.mm-prose', { text: lead.message }) : null,

        el('div.mm-kvgrid.mm-mt-4',
          kv('Email', lead.email),
          kv('Phone', lead.phone),
          kv('Company', lead.companyName),
          kv('City', lead.city),
          kv('Source', fmt.label(lead.source)),
          kv('Campaign', lead.campaignName),
          kv('Score', lead.score),
          kv('Owner', lead.ownerName ?? 'Unassigned'),
          kv('Received', fmt.dateTime(lead.createdAt)),
          kv('Last contacted', lead.lastContactedAt ? fmt.dateTime(lead.lastContactedAt) : 'Not yet')),

        lead.utm && Object.values(lead.utm).some(Boolean)
          ? frag(
              el('h3.mm-label.mm-mt-4', { text: 'Where it came from' }),
              el('div.mm-kvgrid',
                ...Object.entries(lead.utm)
                  .filter(([, v]) => v)
                  .map(([k, v]) => kv(`utm_${k}`, v, { mono: true })),
                lead.pageUrl ? kv('Page', lead.pageUrl, { mono: true }) : null))
          : null,

        session.can('leads.manage')
          ? frag(
              el('div.mm-field.mm-mt-4', el('label.mm-field__label', { text: 'Stage' }), status),
              el('div.mm-row.mm-gap-2.mm-mt-4',
                lead.phone && session.hasFeature('cloud_telephony')
                  ? el('button.mm-btn.mm-btn--ghost', {
                      type: 'button', text: 'Call', onClick: () => close({ action: 'call' }),
                    })
                  : null,
                !lead.convertedClientId
                  ? el('button.mm-btn.mm-btn--ghost', {
                      type: 'button', text: 'Convert to a client', onClick: () => close({ action: 'convert' }),
                    })
                  : null,
                el('span.mm-grow'),
                el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) }),
                el('button.mm-btn.mm-btn--primary', {
                  type: 'button', text: 'Save',
                  onClick: () => close({ action: 'save', status: status.value }),
                })))
          : el('div.mm-row.mm-end.mm-mt-4',
              el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) })));
    },
  });

  if (!result) return;

  if (result.action === 'call') {
    try {
      const { data } = await api.post('/calls/dial', { to: lead.phone, leadId: lead.id });
      notify.success('Calling…', {
        action: data?.call?.id ? { label: 'Open the call', onClick: () => router.go(`/calls/${data.call.id}`) } : null,
      });
    } catch (err) {
      notifyError(err);
    }
    return;
  }

  if (result.action === 'convert') {
    await convert(lead, table);
    return;
  }

  try {
    await api.patch(`/leads/${lead.id}`, { status: result.status });
    notify.success('Saved.');
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}

/**
 * Convert a lead into a client.
 *
 * The client record is created from the lead, and the lead is marked converted
 * rather than deleted — where a client came from is worth keeping.
 */
async function convert(lead, table) {
  const payload = await modal({
    title: `Convert ${lead.fullName}`,
    description: 'A client record and its first filing period are created. The lead is kept, marked converted.',
    body: ({ close }) => {
      const displayName = el('input.mm-input', { value: lead.companyName ?? lead.fullName });
      const gstin = el('input.mm-input', { placeholder: '33AACCN5678K1Z3', maxlength: '15', style: { textTransform: 'uppercase' } });
      const portal = el('input.mm-checkbox', { type: 'checkbox', checked: !!lead.email });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!displayName.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'The client needs a name.' }));
            return;
          }
          close({
            displayName: displayName.value.trim(),
            gstin: gstin.value.trim().toUpperCase() || undefined,
            createPortalLogin: portal.checked,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Client name' }), displayName),
        el('div.mm-field',
          el('label.mm-field__label', { text: 'GSTIN' }), gstin,
          el('p.mm-field__hint', { text: 'Optional — it can be added later.' })),
        el('label.mm-switch',
          portal,
          el('span.mm-switch__text',
            el('span', { text: 'Create a portal login' }),
            el('span.mm-muted.mm-text-xs.mm-block', {
              text: lead.email ? `A one-time password is issued for ${lead.email}.` : 'No email on the lead, so no login can be created.',
            }))),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Convert' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post(`/leads/${lead.id}/convert`, payload);
    notify.success(`${payload.displayName} is now a client.`, {
      action: data?.client?.id
        ? { label: 'Open it', onClick: () => router.go(`/clients/${data.client.id}`) }
        : null,
    });
    if (data?.temporaryPassword) {
      notify.info(`One-time password: ${data.temporaryPassword}`, {
        title: 'Pass this on now',
        timeout: 0,
      });
    }
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}

async function addLead(table) {
  const payload = await modal({
    title: 'Add a lead',
    body: ({ close }) => {
      const fullName = el('input.mm-input', { placeholder: 'Harish Venkatesh' });
      const companyName = el('input.mm-input', { placeholder: 'Anvaya Exports' });
      const email = el('input.mm-input', { type: 'email' });
      const phone = el('input.mm-input', { type: 'tel' });
      const city = el('input.mm-input', { placeholder: 'Coimbatore' });
      const message = el('textarea.mm-input.mm-textarea', { rows: '3', placeholder: 'What are they asking for?' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!fullName.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'A lead needs a name.' }));
            return;
          }
          close({
            fullName: fullName.value.trim(),
            companyName: companyName.value.trim() || undefined,
            email: email.value.trim() || undefined,
            phone: phone.value.trim() || undefined,
            city: city.value.trim() || undefined,
            message: message.value.trim() || undefined,
            source: 'manual',
          });
        },
      },
        errorHost,
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), fullName),
          el('div.mm-field', el('label.mm-field__label', { text: 'Company' }), companyName)),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Email' }), email),
          el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), phone),
          el('div.mm-field', el('label.mm-field__label', { text: 'City' }), city)),
        el('div.mm-field', el('label.mm-field__label', { text: 'What they asked for' }), message),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Add' })));
    },
  });
  if (!payload) return;

  try {
    await api.post('/leads', payload);
    notify.success('Lead added.');
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
