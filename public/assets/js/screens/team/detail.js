/**
 * One person's account.
 *
 * Their role, the permissions granted or withheld beyond it, the companies
 * they can see, and where they are signed in. Every override carries a reason
 * and an expiry, because a permission granted "temporarily" with neither is
 * how a practice ends up with three people holding powers nobody remembers
 * giving them.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, iconButton, statusPill, pill, avatar,
  emptyState, errorState, skeletonTable, notify, notifyError, confirm, modal, banner,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function userDetailScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(6, 3));

  async function load() {
    try {
      const [{ data }, { data: roleData }] = await Promise.all([
        api.get(`/users/${params.id}`),
        api.get('/users/assignable-roles').catch(() => ({ data: { roles: [], permissionCatalogue: [] } })),
      ]);
      setBreadcrumbs([
        { label: 'Team', href: '/team' },
        { label: data.user.fullName },
      ]);
      render(page, ...build(data, roleData, load));
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, roleData, reload) {
  const { user, companies, permissionOverrides, recentLogins, activeSessions, canEdit } = data;
  const isSelf = user.id === session.session().user?.id;

  return [
    pageHead({
      title: user.fullName,
      subtitle: [user.email, user.jobTitle, user.branchName].filter(Boolean).join(' · '),
      actions: frag(
        statusPill(user.status),
        canEdit && session.can('users.update')
          ? frag(
              button('Edit', { variant: 'ghost', icon: 'edit', onClick: () => edit(user, reload) }),
              button('Change role', { variant: 'ghost', icon: 'shield', onClick: () => changeRole(user, roleData, reload) }),
              button('Reset password', { variant: 'ghost', icon: 'key', onClick: () => resetPassword(user) }))
          : null,
        canEdit && !isSelf && session.can('users.delete')
          ? button('Deactivate', { variant: 'danger', icon: 'x', onClick: () => deactivate(user) })
          : null),
    }),

    canEdit ? null : banner({
      text: 'This person holds a role at or above your own, so you can see their account but not change it.',
      tone: 'info',
      icon: 'lock',
    }),

    !user.twoFactorEnabled && user.status === 'active'
      ? banner({
          text: 'This account has no second factor. Anyone with the password can sign in as them.',
          tone: 'warning',
          icon: 'shield',
        })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        overridesCard(user, permissionOverrides ?? [], roleData, canEdit, reload),
        companiesCard(user, companies ?? [], canEdit, reload),
        sessionsCard(user, activeSessions ?? [], canEdit, reload)),

      el('div.mm-stack.mm-gap-4',
        accountCard(user),
        loginsCard(recentLogins ?? []))),
  ].filter(Boolean);
}

function accountCard(user) {
  return card({
    title: 'Account',
    body: frag(
      el('div.mm-row.mm-gap-3.mm-center.mm-mb-4',
        avatar(user.fullName, { size: 'lg' }),
        el('div',
          el('p.mm-fw-medium', { text: user.fullName }),
          el('p.mm-muted.mm-text-sm', { text: user.email }))),

      el('div.mm-kvgrid',
        kv('Role', (user.roles ?? []).map(r => r.name).join(', ') || 'None'),
        kv('Job title', user.jobTitle),
        kv('Phone', user.phone),
        kv('Branch', user.branchName),
        kv('Status', fmt.label(user.status)),
        kv('Two-factor', user.twoFactorEnabled ? 'On' : 'Off'),
        kv('Must change password', user.mustChangePassword ? 'Yes' : 'No'),
        kv('Locale', user.locale),
        kv('Timezone', user.timezone),
        kv('Last signed in', user.lastLoginAt ? fmt.dateTime(user.lastLoginAt) : 'Never'),
        kv('Created', fmt.date(user.createdAt)))),
  });
}

/**
 * Permissions granted or withheld beyond the role.
 *
 * Shown as exceptions, not as the whole permission list — the role is the
 * rule and these are the deviations from it, which is what somebody auditing
 * access actually needs to see.
 */
function overridesCard(user, overrides, roleData, canEdit, reload) {
  return card({
    title: 'Permission exceptions',
    subtitle: overrides.length
      ? `${fmt.plural(overrides.length, 'exception')} beyond their role`
      : 'Their role decides everything.',
    actions: canEdit && session.can('users.update')
      ? button('Add an exception', {
          variant: 'ghost', size: 'sm', icon: 'plus',
          onClick: () => addOverride(user, roleData, reload),
        })
      : null,
    flush: true,
    body: overrides.length
      ? el('ul.mm-list',
          ...overrides.map(override => el('li.mm-list__row',
            el('span.mm-list__icon', { class: override.granted ? 'mm-c-success' : 'mm-c-danger' },
              icon(override.granted ? 'plus' : 'minus', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: override.label }),
              el('span.mm-muted.mm-text-xs', {
                text: [
                  override.granted ? 'Granted beyond their role' : 'Withheld from their role',
                  override.reason,
                  override.expiresAt ? `expires ${fmt.date(override.expiresAt)}` : 'no expiry',
                ].filter(Boolean).join(' · '),
              })),
            override.expiresAt && new Date(override.expiresAt) < new Date()
              ? pill('Expired', 'neutral')
              : null,
            canEdit && session.can('users.update')
              ? iconButton('trash', {
                  label: `Remove ${override.label}`,
                  onClick: () => removeOverride(user, override, reload),
                })
              : null)))
      : emptyState({
          title: 'No exceptions',
          message: 'This account can do exactly what its role allows, and nothing else.',
          icon: 'shield',
          inline: true,
        }),
  });
}

function companiesCard(user, companies, canEdit, reload) {
  return card({
    title: 'Companies they can see',
    actions: canEdit && session.can('users.update')
      ? button('Change', { variant: 'ghost', size: 'sm', onClick: () => setCompanies(user, companies, reload) })
      : null,
    flush: true,
    body: companies.length
      ? el('ul.mm-list',
          ...companies.map(company => el('li.mm-list__row',
            el('span.mm-list__icon.mm-muted', icon('building', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: company.name }),
              company.gstin ? el('span.mm-mono.mm-muted.mm-text-xs', { text: company.gstin }) : null),
            company.isDefault ? pill('Default', 'info') : null)))
      : emptyState({
          title: 'Every company',
          message: 'No restriction is set, so this account sees all of the organisation’s companies.',
          icon: 'building',
          inline: true,
        }),
  });
}

function sessionsCard(user, sessions, canEdit, reload) {
  return card({
    title: 'Where they are signed in',
    subtitle: sessions.length ? `${fmt.plural(sessions.length, 'active session')}` : null,
    flush: true,
    body: sessions.length
      ? el('ul.mm-list',
          ...sessions.map(s => el('li.mm-list__row',
            el('span.mm-list__icon.mm-muted', icon(s.device_kind === 'mobile' ? 'smartphone' : 'grid', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: s.device_label ?? s.user_agent ?? 'Unknown device' }),
              el('span.mm-muted.mm-text-xs', {
                text: [s.ip, `started ${fmt.relative(s.created_at)}`, `last used ${fmt.relative(s.last_used_at ?? s.created_at)}`]
                  .filter(Boolean).join(' · '),
              })),
            canEdit && session.can('users.update')
              ? button('End', {
                  variant: 'ghost', size: 'sm',
                  onClick: () => endSession(user, s, reload),
                })
              : null)))
      : emptyState({ title: 'Not signed in anywhere', icon: 'lock', inline: true }),
  });
}

function loginsCard(logins) {
  return card({
    title: 'Recent sign-ins',
    flush: true,
    body: logins.length
      ? el('ul.mm-list',
          ...logins.map(login => el('li.mm-list__row',
            el('span.mm-list__icon', { class: login.result === 'success' ? 'mm-c-success' : 'mm-c-danger' },
              icon(login.result === 'success' ? 'check-circle' : 'x-circle', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-text-sm', { text: fmt.label(login.result) }),
              el('span.mm-muted.mm-text-xs', {
                text: [login.ip, login.anomaly ? fmt.label(login.anomaly) : null, fmt.dateTime(login.created_at)]
                  .filter(Boolean).join(' · '),
              })))))
      : emptyState({ title: 'No sign-ins recorded', icon: 'clock', inline: true }),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function edit(user, reload) {
  const branches = await api.get('/branches').then(r => r.data ?? []).catch(() => []);

  const payload = await modal({
    title: `Edit ${user.fullName}`,
    body: ({ close }) => {
      const fullName = el('input.mm-input', { value: user.fullName });
      const phone = el('input.mm-input', { type: 'tel', value: user.phone ?? '' });
      const jobTitle = el('input.mm-input', { value: user.jobTitle ?? '' });
      const status = el('select.mm-select',
        ...['active', 'suspended', 'deactivated'].map(s => el('option', {
          value: s, selected: s === user.status, text: fmt.label(s),
        })));
      const branch = el('select.mm-select',
        el('option', { value: '', text: 'No branch' }),
        ...branches.map(b => el('option', { value: b.id, selected: b.id === user.branchId, text: b.name })));

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            fullName: fullName.value.trim(),
            phone: phone.value.trim() || undefined,
            jobTitle: jobTitle.value.trim() || undefined,
            status: status.value,
            branchId: branch.value || undefined,
          });
        },
      },
        el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), fullName),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), phone),
          el('div.mm-field', el('label.mm-field__label', { text: 'Job title' }), jobTitle)),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Status' }), status),
          el('div.mm-field', el('label.mm-field__label', { text: 'Branch' }), branch)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!payload) return;

  try {
    await api.patch(`/users/${user.id}`, payload);
    notify.success('Saved.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function changeRole(user, roleData, reload) {
  const chosen = await modal({
    title: `Role for ${user.fullName}`,
    description: 'A role is a set of permissions. Changing it takes effect on their next request.',
    body: ({ close }) => {
      const current = (user.roles ?? [])[0]?.key;

      return el('ul.mm-menu',
        ...(roleData.roles ?? []).map(role => el('li',
          el('button.mm-menu__item', {
            type: 'button',
            disabled: !role.assignable,
            class: role.key === current ? 'is-active' : '',
            onClick: () => close(role.key),
          },
            el('div',
              el('span.mm-fw-medium', { text: role.name }),
              el('span.mm-muted.mm-text-xs.mm-block', {
                text: role.assignable
                  ? `${role.description} · ${fmt.plural(role.permissionCount, 'permission')}`
                  : 'Above your own role, so you cannot assign it.',
              })),
            role.key === current ? icon('check', { size: 'sm' }) : null))));
    },
  });
  if (!chosen) return;

  try {
    await api.put(`/users/${user.id}/roles`, { roleKeys: [chosen] });
    notify.success('Role changed.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

/**
 * Grant or withhold one permission beyond the role.
 *
 * A reason and an expiry are asked for and the expiry is enforced server-side,
 * so an exception cannot quietly become permanent.
 */
async function addOverride(user, roleData, reload) {
  const catalogue = roleData.permissionCatalogue ?? [];

  const payload = await modal({
    title: 'Permission exception',
    description: 'Use this sparingly. A role change is usually the right answer.',
    size: 'lg',
    body: ({ close }) => {
      const permission = el('select.mm-select',
        ...catalogue.flatMap(group => [
          el('optgroup', { label: group.category },
            ...group.items.map(item => el('option', { value: item.key, text: item.name }))),
        ]));
      const granted = el('select.mm-select',
        el('option', { value: 'true', text: 'Grant it, beyond their role' }),
        el('option', { value: 'false', text: 'Withhold it, despite their role' }));
      const reason = el('textarea.mm-input.mm-textarea', {
        rows: '2', placeholder: 'Covering for Vikram while he is on leave',
      });
      const expiresAt = el('input.mm-input', {
        type: 'date',
        value: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!reason.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'Say why. An exception with no reason cannot be reviewed later.',
            }));
            return;
          }
          close({
            permissionKey: permission.value,
            granted: granted.value === 'true',
            reason: reason.value.trim(),
            expiresAt: expiresAt.value ? new Date(expiresAt.value).toISOString() : undefined,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Permission' }), permission),
        el('div.mm-field', el('label.mm-field__label', { text: 'Grant or withhold' }), granted),
        el('div.mm-field', el('label.mm-field__label', { text: 'Why' }), reason),
        el('div.mm-field',
          el('label.mm-field__label', { text: 'Expires' }), expiresAt,
          el('p.mm-field__hint', { text: 'After this date the exception stops applying, automatically.' })),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Apply' })));
    },
  });
  if (!payload) return;

  try {
    await api.put(`/users/${user.id}/permissions`, payload);
    notify.success('Exception applied.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function removeOverride(user, override, reload) {
  const answer = await confirm({
    title: `Remove the exception on “${override.label}”?`,
    message: 'Their role decides this permission again, from their next request.',
    confirmLabel: 'Remove',
  });
  if (!answer) return;

  try {
    await api.put(`/users/${user.id}/permissions`, {
      permissionKey: override.key,
      granted: override.granted,
      remove: true,
    });
    notify.success('Removed.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function setCompanies(user, current, reload) {
  const all = await api.get('/companies', { pageSize: 200 }).then(r => r.data ?? []).catch(() => []);
  const chosen = new Set(current.map(c => c.id));

  const payload = await modal({
    title: `Companies ${user.fullName} can see`,
    description: 'Leaving all of them unticked means no restriction — they see every company.',
    body: ({ close }) => el('form.mm-form', {
      novalidate: true,
      onSubmit: (e) => { e.preventDefault(); close({ companyIds: [...chosen] }); },
    },
      el('div.mm-stack.mm-gap-1',
        ...all.map(company => el('label.mm-switch',
          el('input.mm-checkbox', {
            type: 'checkbox',
            checked: chosen.has(company.id),
            onChange: (e) => { e.target.checked ? chosen.add(company.id) : chosen.delete(company.id); },
          }),
          el('span.mm-switch__text',
            el('span', { text: company.name }),
            company.gstin ? el('span.mm-muted.mm-text-xs.mm-block', { text: company.gstin }) : null)))),
      el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
        el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
        el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' }))),
  });
  if (!payload) return;

  try {
    await api.put(`/users/${user.id}/companies`, payload);
    notify.success('Saved.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function resetPassword(user) {
  const answer = await confirm({
    title: `Reset ${user.fullName}’s password?`,
    message: 'Their current password stops working immediately and every session of theirs ends.',
    detail: 'A one-time password is shown once, here.',
    confirmLabel: 'Reset it',
    tone: 'danger',
  });
  if (!answer) return;

  try {
    const { data } = await api.post(`/users/${user.id}/reset-password`, {});
    await modal({
      title: 'One-time password',
      size: 'sm',
      body: ({ close }) => frag(
        el('p', { text: `${user.fullName} must sign in with this and change it immediately.` }),
        el('p.mm-mono.mm-text-lg.mm-mt-3', { text: data.temporaryPassword }),
        el('p.mm-muted.mm-text-xs.mm-mt-2', { text: 'It cannot be shown again.' }),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', {
            type: 'button', text: 'Copy',
            onClick: () => { navigator.clipboard?.writeText(data.temporaryPassword); notify.success('Copied.'); },
          }),
          el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Done', onClick: () => close(null) }))),
    });
  } catch (err) {
    notifyError(err);
  }
}

async function endSession(user, sessionRow, reload) {
  try {
    await api.delete(`/users/${user.id}/sessions/${sessionRow.id}`);
    notify.success('Session ended.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function deactivate(user) {
  const answer = await confirm({
    title: `Deactivate ${user.fullName}?`,
    message: 'They can no longer sign in. Their record, and everything they did, stays.',
    confirmLabel: 'Deactivate',
    tone: 'danger',
    confirmText: user.fullName.split(' ')[0],
  });
  if (!answer) return;

  try {
    await api.delete(`/users/${user.id}`);
    notify.success('Deactivated.');
    router.go('/team');
  } catch (err) {
    notifyError(err);
  }
}
