/**
 * One client.
 *
 * The record a practice opens when the phone rings: who they are, where this
 * month stands, what is outstanding, and what has happened lately — in that
 * order, because that is the order the questions come in.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, iconButton, statusPill, pill, avatar,
  emptyState, errorState, skeletonTable, notify, notifyError, modal, confirm, promptText,
} from '../../core/ui.js';
import {
  periodHeader, checklistCard, periodDocumentsCard, periodQueriesCard, periodReportsCard,
} from '../../components/period.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function clientDetailScreen({ params, query }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(8, 4));

  async function load() {
    try {
      const { data } = await api.get(`/clients/${params.id}`);
      setBreadcrumbs([
        { label: 'Clients', href: '/clients' },
        { label: data.client.displayName },
      ]);
      render(page, ...build(data, { reload: load, query }));
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, { reload, query }) {
  const { client, company, contacts, periods, executive, manager, stats } = data;

  return [
    pageHead({
      title: client.displayName,
      subtitle: [client.clientCode, company?.gstin, fmt.label(client.status)]
        .filter(Boolean).join(' · '),
      actions: frag(
        session.hasFeature('cloud_telephony') && client.contactPhone
          ? button('Call', { variant: 'ghost', icon: 'phone', onClick: () => dial(client) })
          : null,
        session.can('documents.upload')
          ? button('Upload', {
              variant: 'ghost', icon: 'upload', href: `/client/upload?clientId=${client.id}`,
            })
          : null,
        session.can('queries.create')
          ? button('Raise a query', { variant: 'ghost', icon: 'message-circle', href: `/queries?clientId=${client.id}` })
          : null,
        session.can('clients.assign')
          ? button('Assign', { variant: 'ghost', icon: 'user-check', onClick: () => assign(client, reload) })
          : null,
        session.can('clients.update')
          ? button('Edit', { variant: 'primary', icon: 'edit', onClick: () => edit(client, reload) })
          : null),
    }),

    statsRow(stats, client),

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        periodsPane(client, periods ?? [], query),
        timelineCard(client)),

      el('div.mm-stack.mm-gap-4',
        detailsCard(client, company),
        teamCard(executive, manager, client),
        contactsCard(client, contacts ?? [], reload))),
  ].filter(Boolean);
}

function statsRow(stats, client) {
  return el('div.mm-grid.mm-grid-4.mm-gap-4',
    stat({
      label: 'Documents',
      value: fmt.number(stats.documents),
      caption: `${fmt.number(stats.verified)} verified`,
      icon: 'files',
      href: `/documents?clientId=${client.id}`,
    }),
    stat({
      label: 'Open questions',
      value: fmt.number(stats.openQueries),
      icon: 'message-circle',
      tone: stats.openQueries > 0 ? 'warning' : null,
      href: `/queries?clientId=${client.id}`,
    }),
    stat({
      label: 'Outstanding',
      value: fmt.moneyShort(stats.outstandingPaise),
      caption: `${fmt.moneyShort(stats.collectedPaise)} collected`,
      icon: 'rupee',
      tone: stats.outstandingPaise > 0 ? 'warning' : null,
      href: `/billing/invoices?clientId=${client.id}`,
    }),
    stat({
      label: 'Reports',
      value: fmt.number(stats.reports),
      caption: stats.calls ? `${fmt.plural(stats.calls, 'call')}` : null,
      icon: 'report',
      href: `/reports?clientId=${client.id}`,
    }));
}

/**
 * The filing periods, with the chosen one expanded.
 *
 * The month strip stays visible while its contents load, so switching months
 * does not collapse the thing you are navigating with.
 */
function periodsPane(client, periods, query) {
  const host = el('div.mm-stack.mm-gap-4');
  const stripHost = el('div');
  const detailHost = el('div.mm-stack.mm-gap-4');

  if (!periods.length) {
    return card({
      title: 'Filing periods',
      body: emptyState({
        title: 'No filing period is open',
        message: 'Open one to create this client’s document checklist for the month.',
        icon: 'calendar',
        inline: true,
        action: session.can('clients.update')
          ? { label: 'Open a period', onClick: () => openPeriod(client) }
          : null,
      }),
    });
  }

  let active = periods.find(p => p.period_key === query.get('period')) ?? periods[0];

  function paintStrip() {
    render(stripHost, el('div.mm-tabs.mm-tabs--scroll',
      ...periods.slice(0, 18).map(period => el('button.mm-tab', {
        type: 'button',
        class: period.id === active.id ? 'is-active' : '',
        onClick: () => {
          active = period;
          router.setQuery({ period: period.period_key });
          paintStrip();
          paintDetail();
        },
      },
        el('span', { text: fmt.period(period.period_key) }),
        el('span.mm-tab__dot', { class: `mm-tab__dot--${toneFor(period.status)}` })))));
  }

  async function paintDetail() {
    render(detailHost, skeletonTable(5, 3));
    try {
      const { data } = await api.get(`/clients/${client.id}/periods/${active.id}`);
      render(detailHost,
        periodHeader(data.period, { stages: data.stages }),
        checklistCard(data.checklist ?? [], {
          uploadHref: `/client/upload?clientId=${client.id}`,
        }),
        periodDocumentsCard(data.documents ?? []),
        (data.computations ?? []).length ? computationsCard(data.computations) : null,
        periodQueriesCard(data.queries ?? []),
        periodReportsCard(data.reports ?? []));
    } catch (err) {
      render(detailHost, errorState(err, { onRetry: paintDetail }));
    }
  }

  paintStrip();
  paintDetail();

  host.append(
    card({
      title: 'Filing periods',
      actions: session.can('clients.update')
        ? button('Open a period', { variant: 'ghost', size: 'sm', icon: 'plus', onClick: () => openPeriod(client) })
        : null,
      body: stripHost,
    }),
    detailHost);

  return host;
}

function computationsCard(computations) {
  return card({
    title: 'Computations',
    flush: true,
    body: el('ul.mm-list',
      ...computations.map(c => el('li.mm-list__row',
        el('a.mm-list__main', { href: `/tax/${c.id}` },
          el('span.mm-fw-medium', { text: `${String(c.regime).toUpperCase()} — ${fmt.money(c.net_payable_paise ?? c.netPayablePaise ?? 0)}` }),
          el('span.mm-muted.mm-text-xs', { text: fmt.relative(c.created_at ?? c.createdAt) })),
        statusPill(c.status)))),
  });
}

function timelineCard(client) {
  const host = el('div');
  render(host, skeletonTable(5, 2));

  api.get(`/clients/${client.id}/timeline`, { pageSize: 25 })
    .then(({ data }) => {
      render(host, data?.length
        ? el('ol.mm-timeline',
            ...data.map(entry => el('li.mm-timeline__item',
              el('span.mm-timeline__dot', { class: `mm-timeline__dot--${toneForVerb(entry.verb)}` }),
              el('div.mm-timeline__content',
                el('p.mm-timeline__title', { text: entry.summary }),
                el('p.mm-timeline__meta', {
                  text: [entry.actor_name, fmt.relative(entry.created_at)].filter(Boolean).join(' · '),
                })))))
        : emptyState({ title: 'Nothing recorded for this client yet', icon: 'activity', inline: true }));
    })
    .catch(err => render(host, errorState(err)));

  return card({
    title: 'Recent activity',
    actions: button('All activity', {
      variant: 'ghost', size: 'sm', href: `/activity?clientId=${client.id}`,
    }),
    flush: true,
    body: host,
  });
}

function detailsCard(client, company) {
  return card({
    title: 'Details',
    body: el('div.mm-kvgrid',
      kv('Client code', client.clientCode, { mono: true }),
      kv('Registered name', company?.name),
      kv('Entity type', company?.entity_type ? fmt.label(company.entity_type) : null),
      kv('GSTIN', company?.gstin, { mono: true }),
      kv('PAN', company?.pan, { mono: true }),
      kv('TAN', company?.tan, { mono: true }),
      kv('State', company?.state_code, { mono: true }),
      kv('GST filing', company?.gst_filing_frequency ? fmt.label(company.gst_filing_frequency) : null),
      kv('Onboarding', fmt.label(client.onboardingStatus)),
      kv('Source', fmt.label(client.source)),
      kv('SLA', client.slaHours ? `${client.slaHours} hours` : null),
      kv('Billing day', client.billingDay),
      kv('Client since', fmt.date(client.createdAt))),
  });
}

function teamCard(executive, manager, client) {
  return card({
    title: 'Who looks after them',
    body: el('ul.mm-people',
      personRow('Executive', executive),
      personRow('Manager', manager),
      !executive && !manager
        ? el('li', el('p.mm-muted.mm-text-sm', { text: 'Nobody is assigned yet.' }))
        : null),
  });
}

function personRow(role, person) {
  if (!person) return null;
  return el('li.mm-people__row',
    avatar(person.full_name, { size: 'sm' }),
    el('div.mm-stack',
      el('span.mm-fw-medium', { text: person.full_name }),
      el('span.mm-muted.mm-text-xs', { text: `${role} · ${person.email}` })));
}

function contactsCard(client, contacts, reload) {
  return card({
    title: 'Contacts',
    actions: session.can('clients.update')
      ? button('Add', { variant: 'ghost', size: 'sm', icon: 'plus', onClick: () => addContact(client, reload) })
      : null,
    flush: true,
    body: contacts.length
      ? el('ul.mm-list',
          ...contacts.map(contact => el('li.mm-list__row',
            avatar(contact.name, { size: 'sm' }),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: contact.name }),
              el('span.mm-muted.mm-text-xs', {
                text: [contact.designation, contact.email, contact.phone].filter(Boolean).join(' · '),
              })),
            contact.is_primary ? pill('Primary', 'info') : null,
            session.can('clients.update') && !contact.is_primary
              ? iconButton('trash', {
                  label: `Remove ${contact.name}`,
                  onClick: () => removeContact(client, contact, reload),
                })
              : null)))
      : emptyState({ title: 'No contacts recorded', icon: 'users', inline: true }),
  });
}

function toneFor(status) {
  if (['filed', 'paid', 'archived'].includes(status)) return 'success';
  if (['query_raised', 'awaiting_client'].includes(status)) return 'warning';
  if (status === 'overdue') return 'danger';
  return 'brand';
}

function toneForVerb(verb) {
  if (['verified', 'approved', 'created', 'paid', 'resolved'].includes(verb)) return 'success';
  if (['rejected', 'deleted'].includes(verb)) return 'danger';
  if (['raised_query', 'noted', 'replied'].includes(verb)) return 'warning';
  return 'brand';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function edit(client, reload) {
  const payload = await modal({
    title: `Edit ${client.displayName}`,
    body: ({ close }) => {
      const displayName = el('input.mm-input', { value: client.displayName, required: true });
      const contactName = el('input.mm-input', { value: client.contactName ?? '' });
      const contactEmail = el('input.mm-input', { type: 'email', value: client.contactEmail ?? '' });
      const contactPhone = el('input.mm-input', { type: 'tel', value: client.contactPhone ?? '' });
      const status = el('select.mm-select',
        ...['active', 'onboarding', 'paused', 'archived'].map(s => el('option', {
          value: s, selected: s === client.status, text: fmt.label(s),
        })));
      const sla = el('input.mm-input', { type: 'number', min: '1', max: '720', value: String(client.slaHours ?? 48) });
      const notes = el('textarea.mm-input.mm-textarea', { rows: '3', value: client.notes ?? '' });
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
            contactName: contactName.value.trim() || undefined,
            contactEmail: contactEmail.value.trim() || undefined,
            contactPhone: contactPhone.value.trim() || undefined,
            status: status.value,
            slaHours: Number(sla.value) || undefined,
            notes: notes.value.trim() || undefined,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Client name' }), displayName),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Contact' }), contactName),
          el('div.mm-field', el('label.mm-field__label', { text: 'Email' }), contactEmail),
          el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), contactPhone)),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Status' }), status),
          el('div.mm-field',
            el('label.mm-field__label', { text: 'SLA (hours)' }), sla,
            el('p.mm-field__hint', { text: 'How long a document of theirs may wait for a decision.' }))),
        el('div.mm-field', el('label.mm-field__label', { text: 'Notes' }), notes),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!payload) return;

  try {
    await api.patch(`/clients/${client.id}`, payload);
    notify.success('Saved.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function assign(client, reload) {
  const people = await api.get('/users', { pageSize: 100 }).then(r => r.data ?? []).catch(() => []);

  const payload = await modal({
    title: 'Assign this client',
    description: 'The people named here are notified, and the client appears in their queue.',
    size: 'sm',
    body: ({ close }) => {
      const executive = el('select.mm-select',
        el('option', { value: '', text: 'Nobody' }),
        ...people.map(p => el('option', {
          value: p.id, selected: p.id === client.assignedExecutiveId, text: p.fullName,
        })));
      const manager = el('select.mm-select',
        el('option', { value: '', text: 'Nobody' }),
        ...people.map(p => el('option', {
          value: p.id, selected: p.id === client.assignedManagerId, text: p.fullName,
        })));

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            executiveId: executive.value || null,
            managerId: manager.value || null,
          });
        },
      },
        el('div.mm-field', el('label.mm-field__label', { text: 'Executive' }), executive),
        el('div.mm-field', el('label.mm-field__label', { text: 'Manager' }), manager),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Assign' })));
    },
  });
  if (!payload) return;

  try {
    await api.post(`/clients/${client.id}/assign`, payload);
    notify.success('Assigned.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function openPeriod(client) {
  const periodKey = await promptText({
    title: 'Open a filing period',
    message: 'A checklist is created from the document types this client files.',
    label: 'Period (YYYY-MM)',
    placeholder: new Date().toISOString().slice(0, 7),
    multiline: false,
    confirmLabel: 'Open it',
    value: new Date().toISOString().slice(0, 7),
  });
  if (!periodKey) return;

  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    notify.error('Write the period as YYYY-MM, for example 2026-09.');
    return;
  }

  try {
    await api.post(`/clients/${client.id}/periods`, { periodKey, periodType: 'monthly' });
    notify.success(`${fmt.period(periodKey)} opened.`);
    router.go(`/clients/${client.id}?period=${periodKey}`);
    window.location.reload();
  } catch (err) {
    notifyError(err);
  }
}

async function addContact(client, reload) {
  const payload = await modal({
    title: 'Add a contact',
    size: 'sm',
    body: ({ close }) => {
      const name = el('input.mm-input', { required: true, placeholder: 'Ravi Kulkarni' });
      const email = el('input.mm-input', { type: 'email', placeholder: 'ravi@example.com' });
      const phone = el('input.mm-input', { type: 'tel', placeholder: '98450 12233' });
      const designation = el('input.mm-input', { placeholder: 'Accounts manager' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Give the contact a name.' }));
            return;
          }
          close({
            name: name.value.trim(),
            email: email.value.trim() || undefined,
            phone: phone.value.trim() || undefined,
            designation: designation.value.trim() || undefined,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), name),
        el('div.mm-field', el('label.mm-field__label', { text: 'Email' }), email),
        el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), phone),
        el('div.mm-field', el('label.mm-field__label', { text: 'Designation' }), designation),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Add' })));
    },
  });
  if (!payload) return;

  try {
    await api.post(`/clients/${client.id}/contacts`, payload);
    notify.success('Contact added.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function removeContact(client, contact, reload) {
  const answer = await confirm({
    title: `Remove ${contact.name}?`,
    message: 'They stop receiving anything about this client.',
    confirmLabel: 'Remove',
    tone: 'danger',
  });
  if (!answer) return;

  try {
    await api.delete(`/clients/${client.id}/contacts/${contact.id}`);
    notify.success('Removed.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

/** Click-to-call, through whichever telephony provider is configured. */
async function dial(client) {
  try {
    const { data } = await api.post('/calls/dial', {
      clientId: client.id,
      to: client.contactPhone,
    });
    notify.success(`Calling ${client.contactName ?? client.displayName}…`, {
      action: data?.call?.id ? { label: 'Open the call', onClick: () => router.go(`/calls/${data.call.id}`) } : null,
    });
  } catch (err) {
    notifyError(err);
  }
}
