/**
 * Backup and restore.
 *
 * An export nobody has ever opened is not a backup. This screen therefore
 * treats verification as a first-class action: a backup that has not been
 * verified says so, and verifying it actually reads the stored file back and
 * checks its manifest rather than reporting success from a database row.
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

export default async function backupScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Backup' }]);

  const page = el('div.mm-page');
  const bodyHost = el('div');

  async function load() {
    render(bodyHost, skeletonTable(5, 3));
    try {
      const { data } = await api.get('/backups');
      render(bodyHost, ...build(data, load));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Backup and restore',
      subtitle: 'Export everything this organisation holds, and check that the export is readable.',
      actions: session.can('settings.manage')
        ? button('Take a backup', { variant: 'primary', icon: 'database', onClick: () => take(load) })
        : null,
    }),
    bodyHost);

  await load();
  return page;
}

function build(data, reload) {
  const backups = data.backups ?? [];
  const restores = data.restores ?? [];
  const verified = backups.filter(b => b.verifiedAt);
  const latest = backups[0];

  return [
    latest && !latest.verifiedAt
      ? banner({
          text: 'Your most recent backup has not been verified. An export nobody has opened is not yet a backup.',
          tone: 'warning',
          icon: 'alert',
          action: session.can('settings.manage')
            ? { label: 'Verify it', onClick: () => verify(latest, reload) }
            : null,
        })
      : null,

    el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Backups', value: fmt.number(backups.length), icon: 'database' }),
      stat({
        label: 'Verified',
        value: fmt.number(verified.length),
        icon: 'check-circle',
        tone: verified.length ? 'success' : null,
      }),
      stat({
        label: 'Most recent',
        value: latest ? fmt.relative(latest.createdAt) : 'Never',
        icon: 'clock',
        tone: !latest ? 'warning' : null,
      }),
      stat({
        label: 'Kept for',
        value: data.retentionDays ? `${data.retentionDays} days` : '—',
        icon: 'calendar',
      })),

    card({
      title: 'Backups',
      flush: true,
      body: backups.length
        ? el('ul.mm-list',
            ...backups.map(backup => el('li.mm-list__row',
              el('span.mm-list__icon', { class: statusTone(backup) },
                icon(backup.status === 'failed' ? 'x-circle' : 'database', { size: 'sm' })),

              el('div.mm-list__main',
                el('span.mm-fw-medium', {
                  text: `${fmt.label(backup.scope)} — ${fmt.dateTime(backup.createdAt)}`,
                }),
                el('span.mm-muted.mm-text-xs', {
                  text: [
                    backup.sizeBytes ? fmt.bytes(backup.sizeBytes) : null,
                    backup.recordCount ? `${fmt.number(backup.recordCount)} records` : null,
                    backup.documentCount ? `${fmt.number(backup.documentCount)} documents` : null,
                    backup.startedByName,
                  ].filter(Boolean).join(' · '),
                }),
                backup.error ? el('span.mm-c-danger.mm-text-xs', { text: backup.error }) : null),

              backup.verifiedAt
                ? pill('Verified', 'success')
                : (backup.status === 'completed' ? pill('Not verified', 'warning') : statusPill(backup.status)),

              backup.status === 'completed' && session.can('settings.manage')
                ? el('div.mm-row.mm-gap-1',
                    button('Verify', { variant: 'ghost', size: 'sm', onClick: () => verify(backup, reload) }),
                    button('Download', {
                      variant: 'ghost', size: 'sm', icon: 'download',
                      onClick: () => download(backup),
                    }))
                : null)))
        : emptyState({
            title: 'No backups yet',
            message: 'A backup exports every record this organisation holds, and — for a full one — the documents themselves.',
            icon: 'database',
            inline: true,
            action: session.can('settings.manage')
              ? { label: 'Take one now', onClick: () => take(reload) }
              : null,
          }),
    }),

    restores.length
      ? card({
          title: 'Restores',
          flush: true,
          body: el('ul.mm-list',
            ...restores.map(restore => el('li.mm-list__row',
              el('span.mm-list__icon.mm-muted', icon('refresh-cw', { size: 'sm' })),
              el('div.mm-list__main',
                el('span.mm-fw-medium', { text: fmt.dateTime(restore.createdAt) }),
                el('span.mm-muted.mm-text-xs', {
                  text: [restore.requestedByName, restore.note].filter(Boolean).join(' · '),
                })),
              statusPill(restore.status)))),
        })
      : null,

    card({
      title: 'What a backup contains',
      body: el('ul.mm-ticklist',
        el('li', icon('check', { size: 'sm' }),
          el('span', { text: 'Every record: clients, documents’ metadata, filings, computations, invoices, payments, the audit trail.' })),
        el('li', icon('check', { size: 'sm' }),
          el('span', { text: 'A full backup also includes the document files themselves.' })),
        el('li', icon('x', { size: 'sm' }),
          el('span', { text: 'Never passwords, API keys or vendor credentials — those are stored only as hashes or as environment variables.' })),
        el('li', icon('shield', { size: 'sm' }),
          el('span', { text: 'Taking, downloading and verifying a backup are all recorded in the audit trail.' }))),
    }),
  ].filter(Boolean);
}

function statusTone(backup) {
  if (backup.status === 'failed') return 'mm-c-danger';
  if (backup.verifiedAt) return 'mm-c-success';
  if (backup.status === 'running') return 'mm-c-brand';
  return 'mm-muted';
}

async function take(reload) {
  const scope = await modal({
    title: 'Take a backup',
    size: 'sm',
    body: ({ close }) => {
      const select = el('select.mm-select',
        el('option', { value: 'data', selected: true, text: 'Records only — fast' }),
        el('option', { value: 'documents', text: 'Documents only' }),
        el('option', { value: 'full', text: 'Everything, records and documents' }));

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => { e.preventDefault(); close(select.value); },
      },
        el('div.mm-field',
          el('label.mm-field__label', { text: 'What to include' }), select,
          el('p.mm-field__hint', { text: 'A full backup of a busy practice can take a few minutes.' })),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Start' })));
    },
  });
  if (!scope) return;

  try {
    const { data } = await api.post('/backups', { scope });
    notify.success(data?.message ?? 'Backup started. It appears below when it finishes.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

/**
 * Verify a backup.
 *
 * The server reads the stored file back and checks its manifest. A missing or
 * unreadable file is reported as such — which is the only reason to have this
 * button at all.
 */
async function verify(backup, reload) {
  try {
    const { data } = await api.post(`/backups/${backup.id}/verify`, {});
    if (data.verified) {
      notify.success(data.message ?? 'The file is present and its manifest reads correctly.');
    } else {
      notify.error(data.reason ?? 'This backup could not be verified.', {
        title: 'Not restorable',
      });
    }
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function download(backup) {
  try {
    const { fileName } = await api.download(`/backups/${backup.id}/download`);
    notify.success(`Downloaded ${fileName}. Store it somewhere other than here.`);
  } catch (err) {
    notifyError(err);
  }
}
