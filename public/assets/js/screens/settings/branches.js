/**
 * Branches.
 *
 * A branch is an office: its people, its clients, and — where GPS attendance
 * is in use — the geofence a check-in is measured against. The geofence is set
 * as a point and a radius, because that is what a check-in is actually
 * compared with.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  skeletonTable, notify, notifyError, confirm, modal, banner,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function branchesScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Branches' }]);

  const page = el('div.mm-page');
  const bodyHost = el('div');

  async function load() {
    render(bodyHost, skeletonTable(4, 3));
    try {
      const [{ data: branches }, performance] = await Promise.all([
        api.get('/branches', { pageSize: 100 }),
        session.can('branches.view')
          ? api.get('/branches/performance').then(r => r.data).catch(() => null)
          : Promise.resolve(null),
      ]);
      render(bodyHost, ...build(branches ?? [], performance, load));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Branches',
      subtitle: 'Your offices, who runs them, and what they handle.',
      actions: session.can('branches.manage')
        ? button('Add a branch', { variant: 'primary', icon: 'plus', onClick: () => openBranch(null, load) })
        : null,
    }),
    bodyHost);

  await load();
  return page;
}

function build(branches, performance, reload) {
  if (!branches.length) {
    return [emptyState({
      title: 'No branches',
      message: 'A single-office practice does not need them. Add one when you open a second.',
      icon: 'map-pin',
      action: session.can('branches.manage')
        ? { label: 'Add a branch', onClick: () => openBranch(null, reload) }
        : null,
    })];
  }

  const totals = performance?.totals;

  return [
    totals
      ? el('div.mm-grid.mm-grid-4.mm-gap-4',
          stat({ label: 'Branches', value: fmt.number(totals.branches), icon: 'map-pin' }),
          stat({ label: 'Staff', value: fmt.number(totals.staff), icon: 'users' }),
          stat({ label: 'Clients', value: fmt.number(totals.clients), icon: 'building' }),
          stat({ label: 'Collected', value: fmt.moneyShort(totals.revenuePaise), icon: 'rupee' }))
      : null,

    el('div.mm-grid.mm-grid-2.mm-gap-4',
      ...branches.map(branch => branchCard(branch, performance, reload))),
  ].filter(Boolean);
}

function branchCard(branch, performance, reload) {
  const figures = performance?.branches?.find(b => b.id === branch.id);

  return card({
    title: branch.name,
    subtitle: [branch.code, branch.address?.city, branch.address?.state].filter(Boolean).join(' · '),
    actions: frag(
      branch.isHeadOffice ? pill('Head office', 'info') : null,
      statusPill(branch.status),
      session.can('branches.manage')
        ? button('Edit', { variant: 'ghost', size: 'sm', icon: 'edit', onClick: () => openBranch(branch, reload) })
        : null),
    body: frag(
      el('div.mm-kvgrid',
        kv('Manager', branch.managerName ?? 'Nobody'),
        kv('Phone', branch.phone),
        kv('Email', branch.email),
        kv('Staff', branch.staffCount),
        kv('Companies', branch.companyCount),
        kv('Geofence', branch.geofence
          ? `${branch.geofence.radiusMetres ?? branch.geofence.radius_metres}m radius`
          : 'Not set')),

      figures
        ? el('div.mm-row.mm-gap-4.mm-wrap.mm-mt-4',
            el('div',
              el('span.mm-figure__label', { text: 'Documents' }),
              el('span.mm-figure__value.mm-numeric.mm-block', { text: fmt.number(figures.documents) })),
            el('div',
              el('span.mm-figure__label', { text: 'Per person' }),
              el('span.mm-figure__value.mm-numeric.mm-block', { text: fmt.number(figures.documentsPerStaff) })),
            el('div',
              el('span.mm-figure__label', { text: 'Verified' }),
              el('span.mm-figure__value.mm-block', {
                text: figures.verificationRatePct === null ? '—' : fmt.percent(figures.verificationRatePct),
              })),
            el('div',
              el('span.mm-figure__label', { text: 'Collected' }),
              el('span.mm-figure__value.mm-numeric.mm-block', { text: fmt.moneyShort(figures.revenuePaise) })))
        : null),
  });
}

async function openBranch(existing, reload) {
  const people = await api.get('/users', { pageSize: 200 }).then(r => r.data ?? []).catch(() => []);

  const result = await modal({
    title: existing ? `Edit ${existing.name}` : 'Add a branch',
    size: 'lg',
    body: ({ close }) => {
      const name = el('input.mm-input', { value: existing?.name ?? '', placeholder: 'Coimbatore' });
      const code = el('input.mm-input', {
        value: existing?.code ?? '', maxlength: '10', placeholder: 'CBE',
        style: { textTransform: 'uppercase' },
      });
      const manager = el('select.mm-select',
        el('option', { value: '', text: 'Nobody yet' }),
        ...people.map(p => el('option', {
          value: p.id, selected: p.id === existing?.managerUserId, text: p.fullName,
        })));
      const phone = el('input.mm-input', { type: 'tel', value: existing?.phone ?? '' });
      const email = el('input.mm-input', { type: 'email', value: existing?.email ?? '' });

      const line1 = el('input.mm-input', { value: existing?.address?.line1 ?? '' });
      const city = el('input.mm-input', { value: existing?.address?.city ?? '' });
      const state = el('input.mm-input', { value: existing?.address?.state ?? '' });
      const stateCode = el('input.mm-input', { value: existing?.address?.stateCode ?? '', maxlength: '2' });
      const pincode = el('input.mm-input', { value: existing?.address?.pincode ?? '', maxlength: '6' });

      const geo = existing?.geofence ?? {};
      const latitude = el('input.mm-input', { type: 'number', step: 'any', value: geo.latitude ?? '' });
      const longitude = el('input.mm-input', { type: 'number', step: 'any', value: geo.longitude ?? '' });
      const radius = el('input.mm-input', {
        type: 'number', min: '20', max: '5000',
        value: geo.radiusMetres ?? geo.radius_metres ?? 150,
      });

      const useHere = el('button.mm-btn.mm-btn--ghost.mm-btn--sm', {
        type: 'button', text: 'Use where I am now',
        onClick: () => {
          if (!navigator.geolocation) {
            notify.warning('This browser cannot report a location.');
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              latitude.value = pos.coords.latitude.toFixed(6);
              longitude.value = pos.coords.longitude.toFixed(6);
              notify.success('Filled in from your current position.');
            },
            () => notify.warning('Your location could not be read. Enter it by hand.'),
            { enableHighAccuracy: true, timeout: 12000 });
        },
      });

      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim() || !code.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'A branch needs a name and a short code.',
            }));
            return;
          }
          const hasGeo = latitude.value && longitude.value;
          close({
            action: 'save',
            name: name.value.trim(),
            code: code.value.trim().toUpperCase(),
            managerUserId: manager.value || undefined,
            phone: phone.value.trim() || undefined,
            email: email.value.trim() || undefined,
            addressLine1: line1.value.trim() || undefined,
            city: city.value.trim() || undefined,
            state: state.value.trim() || undefined,
            stateCode: stateCode.value.trim() || undefined,
            pincode: pincode.value.trim() || undefined,
            latitude: hasGeo ? Number(latitude.value) : undefined,
            longitude: hasGeo ? Number(longitude.value) : undefined,
            geofenceMetres: hasGeo ? (Number(radius.value) || 200) : undefined,
          });
        },
      },
        errorHost,
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), name),
          el('div.mm-field', el('label.mm-field__label', { text: 'Code' }), code),
          el('div.mm-field', el('label.mm-field__label', { text: 'Manager' }), manager)),

        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), phone),
          el('div.mm-field', el('label.mm-field__label', { text: 'Email' }), email)),

        el('h3.mm-label.mm-mt-4', { text: 'Where it is' }),
        el('div.mm-field', el('label.mm-field__label', { text: 'Address' }), line1),
        el('div.mm-grid.mm-grid-4.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'City' }), city),
          el('div.mm-field', el('label.mm-field__label', { text: 'State' }), state),
          el('div.mm-field', el('label.mm-field__label', { text: 'State code' }), stateCode),
          el('div.mm-field', el('label.mm-field__label', { text: 'PIN' }), pincode)),

        el('h3.mm-label.mm-mt-4', { text: 'Geofence' }),
        el('p.mm-muted.mm-text-sm', {
          text: 'A check-in is measured against this point. Leave it blank and a check-in still records a location, but is not judged against an office.',
        }),
        el('div.mm-grid.mm-grid-3.mm-gap-3.mm-mt-2',
          el('div.mm-field', el('label.mm-field__label', { text: 'Latitude' }), latitude),
          el('div.mm-field', el('label.mm-field__label', { text: 'Longitude' }), longitude),
          el('div.mm-field', el('label.mm-field__label', { text: 'Radius (metres)' }), radius)),
        el('div.mm-row.mm-mt-2', useHere),

        el('div.mm-row.mm-gap-2.mm-mt-5',
          existing && !existing.isHeadOffice && session.can('branches.manage')
            ? el('button.mm-btn.mm-btn--ghost.mm-btn--danger-text', {
                type: 'button', text: 'Close this branch', onClick: () => close({ action: 'delete' }),
              })
            : null,
          el('span.mm-grow'),
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: existing ? 'Save' : 'Add it' })));
    },
  });

  if (!result) return;

  if (result.action === 'delete') {
    const answer = await confirm({
      title: `Close ${existing.name}?`,
      message: 'Its staff and clients are not deleted — they simply stop being assigned to a branch.',
      confirmLabel: 'Close it',
      tone: 'danger',
    });
    if (!answer) return;
    try {
      await api.delete(`/branches/${existing.id}`);
      notify.success('Closed.');
      await reload();
    } catch (err) {
      notifyError(err);
    }
    return;
  }

  const { action, ...payload } = result;
  try {
    if (existing) await api.patch(`/branches/${existing.id}`, payload);
    else await api.post('/branches', payload);
    notify.success(existing ? 'Saved.' : `${payload.name} added.`);
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
