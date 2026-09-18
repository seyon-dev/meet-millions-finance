/**
 * The calendar.
 *
 * A month grid on anything wide enough for one, and an agenda list on a phone
 * — a 7×6 grid at 390px is unreadable, and pretending otherwise is how a
 * calendar becomes a screen people never open on mobile.
 *
 * Statutory due dates are drawn alongside meetings but are not events: they
 * are derived from the filing periods, so they cannot drift out of step with
 * them, and they cannot be edited here.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as router from '../core/router.js';
import * as session from '../core/session.js';
import {
  pageHead, card, button, iconButton, statusPill, pill, emptyState, errorState,
  skeletonTable, notify, notifyError, confirm, modal, banner,
} from '../core/ui.js';
import { setBreadcrumbs } from '../layout/shell.js';

const KIND_ICONS = {
  meeting: 'users', call: 'phone', visit: 'map-pin',
  reminder: 'bell', due_date: 'calendar', filing_deadline: 'stamp', deadline: 'stamp',
};

export default async function calendarScreen({ query }) {
  setBreadcrumbs([{ label: 'Calendar' }]);

  const page = el('div.mm-page');
  const bodyHost = el('div');

  // The month being looked at, as the first of that month.
  let cursor = query.get('month')
    ? new Date(`${query.get('month')}-01T00:00:00Z`)
    : startOfMonth(new Date());
  let everyone = query.get('all') === '1';

  async function load() {
    render(bodyHost, skeletonTable(6, 7));
    const from = dayKey(cursor);
    const to = dayKey(endOfMonth(cursor));

    try {
      const { data } = await api.get('/calendar', { from, to, all: everyone ? 'true' : undefined });
      const items = [
        ...(data.events ?? []),
        ...(data.deadlines ?? []).map(d => ({ ...d, startsAt: d.date, allDay: true, derived: true })),
      ].sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));

      render(bodyHost,
        el('div.mm-grid.mm-grid-2-1.mm-gap-4',
          card({
            title: monthLabel(cursor),
            actions: frag(
              iconButton('chevron-left', { label: 'Previous month', onClick: () => move(-1) }),
              button('Today', { variant: 'ghost', size: 'sm', onClick: () => { cursor = startOfMonth(new Date()); sync(); } }),
              iconButton('chevron-right', { label: 'Next month', onClick: () => move(1) })),
            flush: true,
            className: 'mm-card--month',
            body: monthGrid(cursor, items, load),
          }),
          agendaCard(items, load)));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  function move(delta) {
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + delta, 1));
    sync();
  }

  function sync() {
    router.setQuery({ month: `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}` });
    load();
  }

  page.append(
    pageHead({
      title: 'Calendar',
      subtitle: 'Meetings, visits and calls, with statutory due dates alongside them.',
      actions: frag(
        button(everyone ? 'Only mine' : 'Everyone’s', {
          variant: 'ghost', icon: 'users',
          onClick: () => {
            everyone = !everyone;
            router.setQuery({ all: everyone ? '1' : null });
            load();
          },
        }),
        session.can('calendar.manage')
          ? button('New event', { variant: 'primary', icon: 'plus', onClick: () => openEvent(null, load) })
          : null),
    }),
    bodyHost);

  await load();
  return page;
}

/** The month, as a grid of weeks starting on Monday. */
function monthGrid(cursor, items, reload) {
  const first = startOfMonth(cursor);
  const offset = (first.getUTCDay() + 6) % 7;           // Monday = 0
  const daysInMonth = endOfMonth(cursor).getUTCDate();
  const cells = [];

  const byDay = new Map();
  for (const item of items) {
    const key = String(item.startsAt).slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(item);
  }

  for (let i = 0; i < offset; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), day)));
  }

  const today = dayKey(new Date());

  return el('div.mm-calendar',
    el('div.mm-calendar__head',
      ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(name =>
        el('span.mm-calendar__dayname', { text: name }))),

    el('div.mm-calendar__grid',
      ...cells.map((date) => {
        if (!date) return el('div.mm-calendar__cell.is-empty');
        const key = dayKey(date);
        const dayItems = byDay.get(key) ?? [];

        return el('div.mm-calendar__cell', {
          class: [
            key === today ? 'is-today' : '',
            [0, 6].includes(date.getUTCDay()) ? 'is-weekend' : '',
          ].filter(Boolean).join(' '),
        },
          el('span.mm-calendar__date', { text: String(date.getUTCDate()) }),
          ...dayItems.slice(0, 3).map(item => el('button.mm-calendar__event', {
            type: 'button',
            class: `mm-calendar__event--${item.derived ? 'deadline' : item.kind}`,
            title: item.title,
            onClick: () => (item.derived ? router.go('/tax') : openEvent(item, reload)),
          },
            icon(KIND_ICONS[item.kind] ?? 'calendar', { size: 'sm' }),
            el('span', { text: item.title }))),
          dayItems.length > 3
            ? el('span.mm-calendar__more', { text: `+${dayItems.length - 3} more` })
            : null);
      })));
}

function agendaCard(items, reload) {
  const upcoming = items.filter(item => String(item.startsAt).slice(0, 10) >= dayKey(new Date()));

  return card({
    title: 'Coming up',
    subtitle: upcoming.length ? `${fmt.plural(upcoming.length, 'entry', 'entries')} this month` : null,
    flush: true,
    body: upcoming.length
      ? el('ul.mm-list',
          ...upcoming.map(item => el('li.mm-list__row', {
            onClick: () => (item.derived ? router.go('/tax') : openEvent(item, reload)),
          },
            el('span.mm-list__icon', { class: item.derived ? 'mm-c-warning' : 'mm-muted' },
              icon(KIND_ICONS[item.kind] ?? 'calendar', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: item.title }),
              el('span.mm-muted.mm-text-xs', {
                text: [
                  item.allDay ? fmt.date(item.startsAt) : fmt.dateTime(item.startsAt),
                  item.clientName,
                  item.ownerName,
                  item.location,
                ].filter(Boolean).join(' · '),
              })),
            item.derived
              ? pill('Statutory', 'warning')
              : (item.syncStatus && item.syncStatus !== 'local'
                  ? pill(item.syncStatus, item.syncStatus === 'synced' ? 'success' : 'neutral')
                  : null))))
      : emptyState({
          title: 'Nothing left this month',
          message: 'Meetings, visits and calls you add appear here, along with filing deadlines.',
          icon: 'calendar',
          inline: true,
        }),
  });
}

/** Create or edit an event. Derived deadlines never reach this. */
async function openEvent(existing, reload) {
  const clients = await api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => []);
  const canManage = session.can('calendar.manage');

  const result = await modal({
    title: existing ? existing.title : 'New event',
    description: existing ? [existing.clientName, existing.ownerName].filter(Boolean).join(' · ') || null : null,
    body: ({ close }) => {
      if (existing && !canManage) {
        return frag(
          el('p.mm-prose', { text: existing.description ?? 'No description.' }),
          el('div.mm-kvgrid.mm-mt-3',
            el('div.mm-kv',
              el('span.mm-kv__k', { text: 'When' }),
              el('span.mm-kv__v', { text: existing.allDay ? fmt.date(existing.startsAt) : fmt.dateTime(existing.startsAt) })),
            el('div.mm-kv',
              el('span.mm-kv__k', { text: 'Where' }),
              el('span.mm-kv__v', { text: existing.location ?? '—' }))),
          el('div.mm-row.mm-end.mm-mt-4',
            el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) })));
      }

      const title = el('input.mm-input', { value: existing?.title ?? '' });
      const kind = el('select.mm-select',
        ...['meeting', 'call', 'visit', 'reminder', 'due_date'].map(k => el('option', {
          value: k, selected: k === (existing?.kind ?? 'meeting'), text: fmt.label(k),
        })));
      const startsAt = el('input.mm-input', {
        type: 'datetime-local',
        value: existing?.startsAt ? toLocalInput(existing.startsAt) : toLocalInput(new Date().toISOString()),
      });
      const endsAt = el('input.mm-input', {
        type: 'datetime-local',
        value: existing?.endsAt ? toLocalInput(existing.endsAt) : '',
      });
      const location = el('input.mm-input', { value: existing?.location ?? '', placeholder: 'Their office, or a video link' });
      const clientSelect = el('select.mm-select',
        el('option', { value: '', text: 'Not about a client' }),
        ...clients.map(c => el('option', {
          value: c.id, selected: c.id === existing?.clientId, text: c.displayName,
        })));
      const description = el('textarea.mm-input.mm-textarea', { rows: '3', value: existing?.description ?? '' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!title.value.trim() || !startsAt.value) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'An event needs a title and a start time.',
            }));
            return;
          }
          close({
            action: 'save',
            title: title.value.trim(),
            kind: kind.value,
            startsAt: new Date(startsAt.value).toISOString(),
            endsAt: endsAt.value ? new Date(endsAt.value).toISOString() : undefined,
            location: location.value.trim() || undefined,
            clientId: clientSelect.value || undefined,
            description: description.value.trim() || undefined,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Title' }), title),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Kind' }), kind),
          el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), clientSelect)),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Starts' }), startsAt),
          el('div.mm-field', el('label.mm-field__label', { text: 'Ends' }), endsAt)),
        el('div.mm-field', el('label.mm-field__label', { text: 'Where' }), location),
        el('div.mm-field', el('label.mm-field__label', { text: 'Notes' }), description),
        el('div.mm-row.mm-gap-2.mm-mt-4',
          existing
            ? el('button.mm-btn.mm-btn--ghost.mm-btn--danger-text', {
                type: 'button', text: 'Delete', onClick: () => close({ action: 'delete' }),
              })
            : null,
          el('span.mm-grow'),
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: existing ? 'Save' : 'Create' })));
    },
  });

  if (!result) return;

  if (result.action === 'delete') {
    const answer = await confirm({
      title: `Delete “${existing.title}”?`,
      message: 'It disappears from the calendar for everyone who could see it.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!answer) return;
    try {
      await api.delete(`/calendar/${existing.id}`);
      notify.success('Deleted.');
      await reload();
    } catch (err) {
      notifyError(err);
    }
    return;
  }

  const { action, ...payload } = result;
  try {
    if (existing) await api.patch(`/calendar/${existing.id}`, payload);
    else await api.post('/calendar', payload);
    notify.success(existing ? 'Saved.' : 'Event created.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function monthLabel(date) {
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** An ISO instant as the value a datetime-local input expects. */
function toLocalInput(iso) {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
