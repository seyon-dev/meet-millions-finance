/**
 * Attendance and field visits.
 *
 * Check-in is location-verified against the branch geofence, so this screen
 * asks the browser for a position and says plainly what will be recorded. A
 * location taken without saying so is a thing done to somebody rather than
 * with them.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as session from '../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  skeletonTiles, notify, notifyError, modal, banner, lockedState,
} from '../core/ui.js';
import { rankBars } from '../components/charts.js';
import { setBreadcrumbs } from '../layout/shell.js';

export default async function attendanceScreen() {
  setBreadcrumbs([{ label: 'Attendance' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(3));

  async function load() {
    try {
      const [{ data: today }, summary] = await Promise.all([
        api.get('/attendance/today'),
        session.can('attendance.view')
          ? api.get('/attendance/summary').then(r => r.data).catch(() => null)
          : Promise.resolve(null),
      ]);
      render(page, ...build(today, summary, load));
    } catch (err) {
      if (err.name === 'FeatureLocked') {
        render(page,
          pageHead({ title: 'Attendance' }),
          lockedState({
            featureName: 'GPS attendance',
            requiredAddOn: 'employee_gps_attendance',
            message: 'Location-verified check-in and check-out, with client visit logging and travel reports.',
          }));
        return;
      }
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(today, summary, reload) {
  const attendance = today.attendance;

  return [
    pageHead({
      title: 'Attendance',
      subtitle: `${fmt.date(today.day)}${today.branch?.name ? ` · ${today.branch.name}` : ''}`,
      actions: frag(
        today.canCheckIn
          ? button('Check in', { variant: 'primary', icon: 'map-pin', onClick: () => checkIn(today, reload) })
          : null,
        today.canCheckOut
          ? button('Check out', { variant: 'primary', icon: 'logout', onClick: () => checkOut(reload) })
          : null,
        attendance && !today.canCheckOut
          ? null
          : button('Log a visit', { variant: 'ghost', icon: 'map', onClick: () => logVisit(reload) })),
    }),

    today.branch && !today.branch.geofence
      ? banner({
          text: `${today.branch.name} has no geofence set, so a check-in records your location without checking it against an office.`,
          tone: 'info',
          icon: 'info',
          action: session.can('branches.manage')
            ? { label: 'Set one', href: '/settings/branches' }
            : null,
        })
      : null,

    todayCard(attendance, today),

    (today.visits ?? []).length ? visitsCard(today.visits, reload) : null,

    summary ? teamCard(summary) : null,
  ].filter(Boolean);
}

function todayCard(attendance, today) {
  if (!attendance) {
    return card({
      title: 'Today',
      body: emptyState({
        title: 'Not checked in',
        message: today.canCheckIn
          ? 'Checking in records the time and your location, and starts counting your worked hours.'
          : 'Checking in is not available for your account.',
        icon: 'map-pin',
        inline: true,
      }),
    });
  }

  return card({
    title: 'Today',
    actions: statusPill(attendance.status ?? (attendance.check_out_at ? 'completed' : 'present')),
    body: frag(
      el('div.mm-grid.mm-grid-4.mm-gap-4',
        stat({
          label: 'Checked in',
          value: attendance.check_in_at ? fmt.dateTime(attendance.check_in_at).split(', ')[1] : '—',
          caption: attendance.check_in_address ?? null,
          icon: 'clock',
        }),
        stat({
          label: 'Checked out',
          value: attendance.check_out_at ? fmt.dateTime(attendance.check_out_at).split(', ')[1] : 'Still working',
          icon: 'logout',
        }),
        stat({
          label: 'Worked',
          value: attendance.worked_minutes ? fmt.minutes(attendance.worked_minutes) : '—',
          icon: 'activity',
        }),
        stat({
          label: 'Location',
          value: attendance.within_geofence === 0 ? 'Away from the office' : 'At the office',
          tone: attendance.within_geofence === 0 ? 'warning' : 'success',
          icon: 'map-pin',
        })),

      attendance.notes ? el('p.mm-muted.mm-text-sm.mm-mt-3', { text: attendance.notes }) : null),
  });
}

function visitsCard(visits, reload) {
  return card({
    title: 'Visits today',
    flush: true,
    body: el('ul.mm-list',
      ...visits.map(visit => el('li.mm-list__row',
        el('span.mm-list__icon', { class: visit.completed_at ? 'mm-c-success' : 'mm-c-brand' },
          icon('map-pin', { size: 'sm' })),
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: visit.client_name ?? 'Visit' }),
          el('span.mm-muted.mm-text-xs', {
            text: [
              visit.purpose,
              visit.address,
              visit.arrived_at ? fmt.dateTime(visit.arrived_at) : null,
            ].filter(Boolean).join(' · '),
          })),
        visit.completed_at
          ? pill('Completed', 'success')
          : button('Complete', {
              variant: 'ghost', size: 'sm',
              onClick: () => completeVisit(visit, reload),
            })))),
  });
}

function teamCard(summary) {
  return card({
    title: 'The team',
    subtitle: `${fmt.date(summary.period.from)} – ${fmt.date(summary.period.to)}`,
    flush: true,
    body: (summary.staff ?? []).length
      ? el('div.mm-table-wrap',
          el('table.mm-table.mm-table--compact',
            el('thead', el('tr',
              el('th', { text: 'Person' }),
              el('th.mm-align-right', { text: 'Days present' }),
              el('th.mm-align-right', { text: 'Worked' }),
              el('th.mm-align-right.mm-hide-sm', { text: 'Average day' }),
              el('th.mm-align-right.mm-hide-sm', { text: 'Visits' }),
              el('th.mm-align-right.mm-hide-sm', { text: 'Away from branch' }))),
            el('tbody',
              ...summary.staff.map(person => el('tr',
                el('td', { text: person.name }),
                el('td.mm-align-right.mm-numeric', { text: fmt.number(person.daysPresent) }),
                el('td.mm-align-right.mm-numeric', { text: person.workedLabel ?? fmt.minutes(person.workedMinutes) }),
                el('td.mm-align-right.mm-hide-sm.mm-numeric', {
                  text: person.averageDayMinutes ? fmt.minutes(person.averageDayMinutes) : '—',
                }),
                el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: fmt.number(person.visits) }),
                el('td.mm-align-right.mm-hide-sm.mm-numeric', {
                  text: fmt.number(person.daysStartedAwayFromBranch),
                }))))))
      : emptyState({ title: 'Nobody has checked in during this period', icon: 'users', inline: true }),
  });
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * Ask the browser where we are.
 *
 * The permission prompt is the browser's; this only says beforehand what the
 * position is for. A refusal is reported as a refusal, not as an error.
 */
function position() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser cannot report a location, so a check-in cannot be verified.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracyMetres: pos.coords.accuracy,
      }),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? 'Location permission was refused, and a check-in records where it happened. Allow it in your browser and try again.'
          : 'Your location could not be determined. Try again in a moment.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

async function checkIn(today, reload) {
  const confirmed = await modal({
    title: 'Check in',
    size: 'sm',
    body: ({ close }) => {
      const notes = el('textarea.mm-input.mm-textarea', { rows: '2', placeholder: 'Anything to note (optional)' });
      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => { e.preventDefault(); close({ notes: notes.value.trim() || undefined }); },
      },
        el('p.mm-prose', {
          text: today.branch?.geofence
            ? `Your position is recorded and checked against ${today.branch.name}.`
            : 'Your position and the time are recorded.',
        }),
        el('div.mm-field', el('label.mm-field__label', { text: 'Notes' }), notes),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Check in' })));
    },
  });
  if (!confirmed) return;

  try {
    const where = await position();
    const { data } = await api.post('/attendance/check-in', { ...where, ...confirmed });
    notify.success(data?.withinGeofence === false
      ? 'Checked in, recorded as away from the office.'
      : 'Checked in.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function checkOut(reload) {
  try {
    // A position here is best-effort: refusing it should not trap somebody in
    // a shift they have finished.
    let where = {};
    try { where = await position(); } catch { where = {}; }

    const { data } = await api.post('/attendance/check-out', where);
    notify.success(data?.workedMinutes
      ? `Checked out. ${fmt.minutes(data.workedMinutes)} today.`
      : 'Checked out.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function logVisit(reload) {
  const clients = await api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => []);

  const payload = await modal({
    title: 'Log a client visit',
    description: 'Your position is recorded as the visit’s location.',
    body: ({ close }) => {
      const clientSelect = el('select.mm-select',
        el('option', { value: '', text: 'Choose a client' }),
        ...clients.map(c => el('option', { value: c.id, text: c.displayName })));
      const purpose = el('input.mm-input', { placeholder: 'Collect the September documents' });
      const notes = el('textarea.mm-input.mm-textarea', { rows: '2' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!clientSelect.value) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Choose a client.' }));
            return;
          }
          close({
            clientId: clientSelect.value,
            purpose: purpose.value.trim() || undefined,
            notes: notes.value.trim() || undefined,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), clientSelect),
        el('div.mm-field', el('label.mm-field__label', { text: 'Why are you there?' }), purpose),
        el('div.mm-field', el('label.mm-field__label', { text: 'Notes' }), notes),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Log it' })));
    },
  });
  if (!payload) return;

  try {
    const where = await position();
    await api.post('/attendance/visits', { ...payload, ...where });
    notify.success('Visit logged.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function completeVisit(visit, reload) {
  const payload = await modal({
    title: 'Complete the visit',
    size: 'sm',
    body: ({ close }) => {
      const notes = el('textarea.mm-input.mm-textarea', { rows: '3', placeholder: 'What came of it?' });
      const collected = el('input.mm-input', { type: 'number', min: '0', value: '0' });

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            notes: notes.value.trim() || undefined,
            documentsCollected: Number(collected.value) || 0,
          });
        },
      },
        el('div.mm-field', el('label.mm-field__label', { text: 'Notes' }), notes),
        el('div.mm-field', el('label.mm-field__label', { text: 'Documents collected' }), collected),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Complete' })));
    },
  });
  if (!payload) return;

  try {
    await api.post(`/attendance/visits/${visit.id}/complete`, payload);
    notify.success('Visit completed.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
