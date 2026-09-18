/**
 * The client's filing history.
 *
 * A month is chosen on the left and shown on the right. On a phone the two
 * stack, with the chooser as a horizontal strip — a sidebar of twenty-four
 * months on a 375px screen is a scroll nobody finishes.
 */

import { el, render } from '../../core/dom.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import {
  pageHead, card, errorState, emptyState, statusPill, skeletonTable, button,
} from '../../core/ui.js';
import {
  periodHeader, checklistCard, periodDocumentsCard, periodQueriesCard, periodReportsCard,
} from '../../components/period.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function clientFilingsScreen({ query }) {
  setBreadcrumbs([{ label: 'Your filings', href: '/client/dashboard' }, { label: 'All months' }]);

  const page = el('div.mm-page');
  const detailHost = el('div.mm-split__detail');
  const listHost = el('div.mm-split__list');

  let clients;
  try {
    ({ data: clients } = await api.get('/clients', { pageSize: 50 }));
  } catch (err) {
    render(page, errorState(err));
    return page;
  }

  if (!clients?.length) {
    render(page,
      pageHead({ title: 'Your filings' }),
      emptyState({
        title: 'No company is linked to your account',
        message: 'Ask your accountant to link your login to your company record.',
        icon: 'building',
      }));
    return page;
  }

  const clientId = query.get('clientId') ?? clients[0].id;
  const client = clients.find(c => c.id === clientId) ?? clients[0];

  let periods = [];
  try {
    ({ data: periods } = await api.get(`/clients/${client.id}/periods`));
  } catch (err) {
    render(page, errorState(err));
    return page;
  }

  page.append(
    pageHead({
      title: 'Your filings',
      subtitle: client.displayName,
      actions: button('Upload documents', { variant: 'primary', icon: 'upload', href: '/client/upload' }),
    }),
    clients.length > 1 ? companyStrip(clients, client.id) : null,
    el('div.mm-split', listHost, detailHost));

  if (!periods.length) {
    render(detailHost, emptyState({
      title: 'No filing months yet',
      message: 'Your accountant opens a month when your filing period starts.',
      icon: 'calendar',
    }));
    return page;
  }

  const wanted = query.get('period');
  let active = periods.find(p => p.period_key === wanted) ?? periods[0];

  function paintList() {
    render(listHost, el('nav.mm-monthlist', { 'aria-label': 'Filing months' },
      ...periods.map(period => el('button.mm-monthlist__item', {
        type: 'button',
        class: period.id === active.id ? 'is-active' : '',
        'aria-current': period.id === active.id ? 'true' : null,
        onClick: () => {
          active = period;
          router.setQuery({ period: period.period_key });
          paintList();
          paintDetail();
        },
      },
        el('span.mm-monthlist__key', { text: fmt.label(period.period_key) }),
        statusPill(period.status))))); 
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
        el('div.mm-grid.mm-grid-2.mm-gap-4',
          periodDocumentsCard(data.documents ?? []),
          periodQueriesCard(data.queries ?? [])),
        periodReportsCard(data.reports ?? []));
    } catch (err) {
      render(detailHost, errorState(err, { onRetry: paintDetail }));
    }
  }

  paintList();
  await paintDetail();
  return page;
}

function companyStrip(clients, activeId) {
  return card({
    flush: true,
    body: el('div.mm-tabs',
      ...clients.map(client => el('a.mm-tab', {
        href: `/client/filings?clientId=${client.id}`,
        class: client.id === activeId ? 'is-active' : '',
      }, el('span', { text: client.displayName })))),
  });
}
