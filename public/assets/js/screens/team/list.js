/**
 * The team.
 *
 * Who is in the practice, what they may do, and whether their account is
 * protected. Two-factor adoption is shown as a column rather than buried in
 * settings, because "who still has no second factor" is a question an
 * administrator asks and should not have to go looking for.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, avatar,
  notify, notifyError, modal, banner,
} from '../../core/ui.js';
import { dataTable, selectFilter } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function teamScreen() {
  setBreadcrumbs([{ label: 'Team' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');

  const [roleData, branches] = await Promise.all([
    api.get('/users/assignable-roles').then(r => r.data).catch(() => ({ roles: [] })),
    api.get('/branches').then(r => r.data ?? []).catch(() => []),
  ]);

  const table = dataTable({
    searchPlaceholder: 'Search by name, email or job title…',
    defaultSort: 'created_at',
    onRowClick: (row) => router.go(`/settings/users/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'Role',
        options: (roleData.roles ?? []).map(r => ({ value: r.key, label: r.name })),
        // The API reads `role`; sending `roleKey` filtered nothing at all.
        value: active.role ?? '',
        onChange: v => apply('role', v),
      }),
      selectFilter({
        label: 'People',
        options: [
          { value: 'staff', label: 'People: who works here' },
          { value: 'all', label: 'People: including client logins' },
        ],
        value: active.staff === 'false' ? 'all' : 'staff',
        allLabel: null,
        onChange: v => apply('staff', v === 'all' ? 'false' : 'true'),
      }),
      selectFilter({
        label: 'Status',
        options: ['active', 'invited', 'suspended', 'deactivated'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
      branches.length > 1
        ? selectFilter({
            label: 'Branch',
            options: branches.map(b => ({ value: b.id, label: b.name })),
            value: active.branchId ?? '',
            onChange: v => apply('branchId', v),
          })
        : null,
    ].filter(Boolean),
    // A firm's clients have logins here too, and counting them as team members
    // makes a six-person practice look like eleven.
    initialFilters: { staff: 'true' },
    load: async (params) => {
      const { data, meta } = await api.get('/users', params);
      paintTiles(meta.summary);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'fullName',
        label: 'Person',
        primary: true,
        render: row => el('div.mm-row.mm-gap-3',
          avatar(row.fullName, { size: 'sm' }),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: row.fullName }),
            el('span.mm-muted.mm-text-xs', { text: row.email }))),
      },
      {
        key: 'primaryRole',
        label: 'Role',
        render: row => (row.primaryRole
          ? pill(row.primaryRole.name, row.primaryRole.key === 'client' ? 'neutral' : 'info')
          : el('span.mm-muted.mm-text-xs', { text: 'No role' })),
      },
      {
        key: 'jobTitle',
        label: 'Job title',
        hideOnMobile: true,
        render: row => (row.jobTitle ? el('span.mm-text-sm', { text: row.jobTitle }) : null),
      },
      {
        key: 'branchName',
        label: 'Branch',
        hideOnMobile: true,
        render: row => (row.branchName ? el('span.mm-text-sm', { text: row.branchName }) : null),
      },
      {
        key: 'twoFactorEnabled',
        label: '2FA',
        align: 'center',
        render: row => (row.twoFactorEnabled
          ? icon('shield', { size: 'sm', className: 'mm-c-success', title: 'Two-factor is on' })
          : icon('alert', { size: 'sm', className: 'mm-c-warning', title: 'No second factor' })),
      },
      {
        key: 'lastLoginAt',
        label: 'Last seen',
        hideOnMobile: true,
        render: row => (row.lastLoginAt
          ? el('span.mm-text-xs', { title: fmt.dateTime(row.lastLoginAt), text: fmt.relative(row.lastLoginAt) })
          : el('span.mm-muted.mm-text-xs', { text: 'Never' })),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
    ],
    empty: {
      title: 'Nobody else yet',
      message: 'Invite the people who work on your clients’ filings.',
      icon: 'users',
      action: session.can('users.create')
        ? { label: 'Invite someone', onClick: () => invite(roleData, branches, table) }
        : null,
    },
  });

  function paintTiles(summary) {
    if (!summary) return;
    const adoption = summary.active ? Math.round((summary.withTwoFactor / summary.active) * 100) : 0;

    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'People', value: fmt.number(summary.total), icon: 'users' }),
      stat({ label: 'Active', value: fmt.number(summary.active), icon: 'check-circle', tone: 'success' }),
      stat({
        label: 'Invited, not yet in',
        value: fmt.number(summary.invited),
        icon: 'mail',
        tone: summary.invited ? 'warning' : null,
      }),
      stat({
        label: 'Two-factor',
        value: `${adoption}%`,
        caption: `${fmt.number(summary.withTwoFactor)} of ${fmt.number(summary.active)} active accounts`,
        icon: 'shield',
        tone: adoption >= 90 ? 'success' : adoption >= 50 ? 'warning' : 'danger',
      })));
  }

  page.append(
    pageHead({
      title: 'Team',
      subtitle: 'Everyone with an account in this organisation.',
      actions: frag(
        session.can('analytics.view')
          ? button('Performance', { variant: 'ghost', icon: 'bar-chart', href: '/team/performance' })
          : null,
        session.can('users.create')
          ? button('Invite someone', {
              variant: 'primary', icon: 'user-plus',
              onClick: () => invite(roleData, branches, table),
            })
          : null),
    }),
    tileHost,
    card({ body: table.node, flush: true }));

  return page;
}

/**
 * Invite a colleague.
 *
 * Roles above the inviter's own level are shown but disabled, with the reason
 * — a role list that silently omits options makes the permission model look
 * arbitrary.
 */
async function invite(roleData, branches, table) {
  const payload = await modal({
    title: 'Invite someone',
    description: 'They receive an email with a link to set their own password.',
    body: ({ close }) => {
      const fullName = el('input.mm-input', { placeholder: 'Lakshmi Iyer' });
      const email = el('input.mm-input', { type: 'email', placeholder: 'lakshmi@yourfirm.example' });
      const phone = el('input.mm-input', { type: 'tel' });
      const jobTitle = el('input.mm-input', { placeholder: 'Accountant' });

      const role = el('select.mm-select',
        ...(roleData.roles ?? []).map(r => el('option', {
          value: r.key,
          disabled: !r.assignable,
          text: r.assignable ? r.name : `${r.name} — above your own role`,
        })));

      const branch = branches.length
        ? el('select.mm-select',
            el('option', { value: '', text: 'No branch' }),
            ...branches.map(b => el('option', { value: b.id, text: b.name })))
        : null;

      const sendInvite = el('input.mm-checkbox', { type: 'checkbox', checked: true });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!fullName.value.trim() || !email.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'A name and an email address are needed.',
            }));
            return;
          }
          close({
            fullName: fullName.value.trim(),
            email: email.value.trim(),
            phone: phone.value.trim() || undefined,
            jobTitle: jobTitle.value.trim() || undefined,
            roleKey: role.value,
            branchId: branch?.value || undefined,
            sendInvite: sendInvite.checked,
          });
        },
      },
        errorHost,
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), fullName),
          el('div.mm-field', el('label.mm-field__label', { text: 'Email' }), email)),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Phone' }), phone),
          el('div.mm-field', el('label.mm-field__label', { text: 'Job title' }), jobTitle)),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Role' }), role),
          branch ? el('div.mm-field', el('label.mm-field__label', { text: 'Branch' }), branch) : null),
        el('label.mm-switch.mm-mt-2',
          sendInvite,
          el('span.mm-switch__text',
            el('span', { text: 'Email them an invitation' }),
            el('span.mm-muted.mm-text-xs.mm-block', {
              text: 'Without this, a one-time password is shown here for you to pass on yourself.',
            }))),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Invite' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/users', payload);
    notify.success(`${payload.fullName} has been invited.`);

    if (data?.temporaryPassword) {
      // Shown once, and only here. It is never stored in a readable form.
      await modal({
        title: 'One-time password',
        size: 'sm',
        body: ({ close }) => frag(
          el('p', { text: `${payload.fullName} can sign in with this once, and must change it immediately.` }),
          el('p.mm-mono.mm-text-lg.mm-mt-3', { text: data.temporaryPassword }),
          el('p.mm-muted.mm-text-xs.mm-mt-2', { text: 'It cannot be shown again.' }),
          el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
            el('button.mm-btn.mm-btn--ghost', {
              type: 'button', text: 'Copy',
              onClick: () => {
                navigator.clipboard?.writeText(data.temporaryPassword);
                notify.success('Copied.');
              },
            }),
            el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Done', onClick: () => close(null) }))),
      });
    }
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
