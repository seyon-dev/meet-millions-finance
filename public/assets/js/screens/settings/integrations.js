/**
 * Integrations.
 *
 * Every vendor this deployment can talk to, grouped by what it is for, with
 * one honest status each. The distinction that matters is between three
 * states, and this screen never blurs them:
 *
 *   not connected  — the credentials are not on the server
 *   connected      — the credentials are there and the vendor answered
 *   failed         — the credentials are there and the vendor rejected them
 *
 * Credentials themselves are environment variables on the Worker. They are
 * never entered here, never sent here, and never displayed — this screen only
 * names which ones are missing.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  skeletonTiles, notify, notifyError, modal, banner, confirm,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

const CATEGORY_ICONS = {
  email: 'mail', sms: 'smartphone', whatsapp: 'message-circle', push: 'bell',
  ocr: 'scan-text', speech: 'mic', llm: 'sparkle', storage: 'database',
  leads: 'magnet', calendar: 'calendar', esign: 'pen-tool', dns: 'network',
  payments: 'credit-card', telephony: 'phone', security: 'shield-check',
};

/**
 * Headings, written out.
 *
 * Title-casing a key gives "Sms", "Whatsapp", "Llm" and "Esign" — every one of
 * which is a product name somebody would recognise spelled wrongly.
 */
const CATEGORY_LABELS = {
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  push: 'Push notifications',
  ocr: 'OCR',
  speech: 'Speech-to-text',
  llm: 'AI',
  storage: 'Cloud storage',
  leads: 'Lead capture',
  calendar: 'Calendar',
  esign: 'e-Sign',
  dns: 'Custom domains',
  payments: 'Payments',
  telephony: 'Telephony',
  security: 'Security',
};

const categoryLabel = key => CATEGORY_LABELS[key] ?? fmt.label(key);

export default async function integrationsScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Integrations' }]);

  const page = el('div.mm-page');
  const bodyHost = el('div');

  async function load() {
    render(bodyHost, skeletonTiles(4));
    try {
      const [{ data }, storage] = await Promise.all([
        api.get('/integrations'),
        // Folder mappings are what make Drive/Dropbox/OneDrive actually sync;
        // without one the engine has nothing to match a document against.
        api.get('/integrations/storage/folders').then(r => r.data).catch(() => null),
      ]);
      render(bodyHost, ...build(data, load, storage));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Integrations',
      subtitle: 'What this deployment can reach, and what each one still needs.',
    }),
    bodyHost);

  await load();
  return page;
}

function build(data, reload, storage) {
  const summary = data.summary ?? {};
  const byCategory = Object.entries(data.byCategory ?? {});

  return [
    el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Vendors', value: fmt.number(summary.total ?? 0), icon: 'plug' }),
      stat({
        label: 'Connected',
        value: fmt.number(summary.connected ?? 0),
        icon: 'check-circle',
        tone: 'success',
      }),
      stat({
        label: 'Awaiting credentials',
        value: fmt.number(summary.awaitingCredentials ?? 0),
        icon: 'key',
        tone: (summary.awaitingCredentials ?? 0) > 0 ? 'warning' : null,
      }),
      stat({
        label: 'Awaiting an account link',
        value: fmt.number(summary.awaitingAccountLink ?? 0),
        icon: 'link',
      })),

    banner({
      text: 'Credentials live as environment variables on the Worker. They are never typed into this screen, and nothing here can read them — only whether they are set.',
      tone: 'info',
      icon: 'lock',
    }),

    ...byCategory.map(([category, integrations]) => card({
      title: categoryLabel(category),
      subtitle: `${integrations.filter(i => i.configured).length} of ${integrations.length} ready`,
      flush: true,
      body: el('ul.mm-list',
        ...integrations.map(integration => row(integration, reload))),
    })),

    storageCard(data, storage, reload),
  ].filter(Boolean);
}

/**
 * Where verified documents are mirrored.
 *
 * A connected Drive account syncs nothing on its own: the engine reads folder
 * mappings, and until one exists every document it is handed matches no map
 * and is dropped. This card is where a mapping is made.
 */
function storageCard(data, storage, reload) {
  const connected = (data.integrations ?? [])
    .filter(i => ['google_drive', 'dropbox', 'onedrive'].includes(i.key) && i.status === 'connected');

  const folders = storage?.folders ?? [];
  const canManage = session.can('integrations.manage');

  return card({
    title: 'Document sync folders',
    subtitle: folders.length
      ? `${folders.length} mapping${folders.length === 1 ? '' : 's'} — verified documents are copied to each`
      : 'Nothing is mapped, so no document is being copied anywhere',
    actions: canManage && connected.length
      ? button('Map a folder', { variant: 'primary', icon: 'plus', onClick: () => mapFolder(connected, reload) })
      : null,
    flush: !!folders.length,
    body: folders.length
      ? el('ul.mm-list', ...folders.map(f => folderRow(f, reload, canManage)))
      : emptyState({
          title: connected.length ? 'No folder is mapped yet' : 'No cloud storage is connected',
          message: connected.length
            ? 'Google Drive, Dropbox and OneDrive each need a folder mapping before anything syncs. '
              + 'A connected account on its own copies nothing.'
            : 'Connect Google Drive, Dropbox or OneDrive above, then map a folder to start mirroring '
              + 'verified documents.',
          icon: 'database',
          inline: true,
        }),
  });
}

function folderRow(folder, reload, canManage) {
  const stale = folder.integrationStatus && folder.integrationStatus !== 'connected';

  return el('li.mm-list__row',
    el('span.mm-list__icon', icon(CATEGORY_ICONS.storage ?? 'database', { size: 'sm' })),
    el('div.mm-list__main',
      el('span.mm-fw-medium', { text: `${fmt.vendor(folder.provider)} — ${folder.remotePath}` }),
      el('span.mm-muted.mm-text-xs', {
        text: [
          folder.scopeLabel,
          `on ${folder.syncOn}`,
          folder.autoSync ? 'automatic' : 'manual',
          folder.preserveVersions ? 'keeps versions' : 'latest only',
          folder.pendingCount ? `${folder.pendingCount} waiting` : null,
        ].filter(Boolean).join(' · '),
      })),
    stale ? pill(fmt.label(folder.integrationStatus), 'warning') : null,
    folder.pendingCount ? pill(`${folder.pendingCount} queued`, 'info') : null,
    canManage
      ? button('', {
          variant: 'ghost', icon: 'trash', size: 'sm', title: 'Remove this mapping',
          onClick: () => unmapFolder(folder, reload),
        })
      : null);
}

async function mapFolder(connected, reload) {
  await modal({
    title: 'Map a sync folder',
    size: 'sm',
    body: ({ close }) => {
      const provider = el('select.mm-input.mm-select',
        ...connected.map(i => el('option', { value: i.key, text: i.name })));
      const path = el('input.mm-input', { placeholder: '/Meet Millions/Verified documents' });
      const syncOn = el('select.mm-input.mm-select',
        el('option', { value: 'verified', text: 'When a document is verified', selected: true }),
        el('option', { value: 'approved', text: 'When a report is approved' }),
        el('option', { value: 'upload', text: 'As soon as it is uploaded' }));

      const submit = button('Map folder', {
        variant: 'primary',
        onClick: async () => {
          if (!path.value.trim()) { notify.warning('Give the folder a path.'); path.focus(); return; }
          submit.disabled = true;
          try {
            await api.post('/integrations/storage/folders', {
              provider: provider.value,
              remotePath: path.value.trim(),
              syncOn: syncOn.value,
              scopeType: 'tenant',
            });
            notify.success('Folder mapped. Verified documents will be copied there from now on.');
            close();
            reload();
          } catch (err) {
            notifyError(err);
            submit.disabled = false;
          }
        },
      });

      return el('div.mm-stack.mm-gap-3',
        el('label.mm-field', el('span.mm-field__label', { text: 'Provider' }), provider),
        el('label.mm-field', el('span.mm-field__label', { text: 'Folder path' }), path),
        el('label.mm-field', el('span.mm-field__label', { text: 'Copy a document' }), syncOn),
        el('p.mm-muted.mm-text-xs', {
          text: 'The folder is created on the provider if it does not exist. Existing documents are not '
            + 'back-filled — the mapping applies from now on.',
        }),
        el('div.mm-row.mm-gap-2', el('span.mm-grow'), submit));
    },
  });
}

async function unmapFolder(folder, reload) {
  const yes = await confirm({
    title: 'Remove this mapping?',
    message: `${fmt.vendor(folder.provider)} will stop receiving documents at ${folder.remotePath}. `
      + `${folder.pendingCount ? `${folder.pendingCount} document(s) still waiting to sync will be dropped. ` : ''}`
      + 'Files already copied there are left alone.',
    confirmLabel: 'Remove mapping',
    tone: 'danger',
  });
  if (!yes) return;

  try {
    const { data } = await api.delete(`/integrations/storage/folders/${folder.id}`);
    notify.success(data?.queuedDropped
      ? `Mapping removed. ${data.queuedDropped} queued item(s) were dropped.`
      : 'Mapping removed.');
    reload();
  } catch (err) {
    notifyError(err);
  }
}

function row(integration, reload) {
  return el('li.mm-list__row', {
    onClick: () => openIntegration(integration, reload),
  },
    el('span.mm-list__icon', { class: toneClass(integration) },
      icon(CATEGORY_ICONS[integration.category] ?? 'plug', { size: 'sm' })),

    el('div.mm-list__main',
      el('span.mm-fw-medium', { text: integration.name }),
      el('span.mm-muted.mm-text-xs', { text: statusLine(integration) })),

    integration.addOn && !integration.addOnActive
      ? pill('Add-on not active', 'neutral')
      : statusPill(integration.status),

    integration.lastTestAt
      ? el('span.mm-muted.mm-text-xs.mm-nowrap', {
          title: fmt.dateTime(integration.lastTestAt),
          text: `Tested ${fmt.relative(integration.lastTestAt)}`,
        })
      : null);
}

function statusLine(integration) {
  if (integration.selfHosted) return 'Served by this deployment — no external credentials needed.';
  if (integration.missingKeys?.length) {
    return `Needs ${integration.missingKeys.join(', ')}`;
  }
  if (integration.needsAccountLink) return 'Credentials are set; an account still needs to be linked.';
  if (integration.lastTestOk === 0) return integration.lastTestMessage ?? 'The vendor rejected the credentials.';
  return `Ready${integration.account ? ` · ${integration.account}` : ''}`;
}

function toneClass(integration) {
  if (integration.status === 'connected' || integration.selfHosted) return 'mm-c-success';
  if (integration.status === 'failed') return 'mm-c-danger';
  if (integration.missingKeys?.length) return 'mm-c-warning';
  return 'mm-muted';
}

/**
 * One vendor.
 *
 * Says exactly what it is for, which environment variables it needs, which of
 * them are missing, and what happened the last time somebody tested it.
 */
async function openIntegration(integration, reload) {
  const result = await modal({
    title: integration.name,
    description: `${categoryLabel(integration.category)}${integration.addOn ? ` · part of the ${fmt.label(integration.addOn)} add-on` : ''}`,
    size: 'lg',
    body: ({ close }) => frag(
      integration.selfHosted
        ? banner({
            text: 'This one is served by the application itself. There is nothing to connect.',
            tone: 'success',
            icon: 'check-circle',
          })
        : null,

      integration.addOn && !integration.addOnActive
        ? banner({
            text: `The ${fmt.label(integration.addOn)} add-on is not active, so this stays switched off even with credentials set.`,
            tone: 'warning',
            icon: 'package',
            action: { label: 'See the add-on', href: `/marketplace?addon=${integration.addOn}` },
          })
        : null,

      integration.lastTestOk === 0 && integration.lastTestMessage
        ? banner({ text: integration.lastTestMessage, tone: 'danger', icon: 'x-circle' })
        : null,

      el('div.mm-kvgrid',
        kv('Status', fmt.label(integration.status)),
        kv('Category', integration.label ?? categoryLabel(integration.category)),
        kv('Account', integration.account),
        kv('Last tested', integration.lastTestAt ? fmt.dateTime(integration.lastTestAt) : 'Never'),
        kv('Last sync', integration.lastSyncAt ? fmt.dateTime(integration.lastSyncAt) : 'Never')),

      integration.requiredKeys?.length
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Environment variables it needs' }),
            el('ul.mm-keylist',
              ...integration.requiredKeys.map(key => el('li',
                el('code.mm-mono', { text: key }),
                integration.missingKeys?.includes(key) ? pill('Missing', 'warning') : pill('Set', 'success'))),
              ...(integration.optionalKeys ?? []).map(key => el('li',
                el('code.mm-mono', { text: key }),
                integration.missingKeys?.includes(key) ? pill('Optional', 'neutral') : pill('Set', 'success')))),
            el('p.mm-muted.mm-text-xs.mm-mt-2', {
              text: 'Set these with `wrangler secret put`, or in the Worker’s environment. They never pass through this interface.',
            }))
        : null,

      integration.oauth
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Account link' }),
            el('p.mm-prose', {
              text: integration.oauth.connected
                ? `Linked to ${integration.oauth.account ?? 'an account'}${integration.oauth.expiresAt ? `, valid until ${fmt.dateTime(integration.oauth.expiresAt)}` : ''}.`
                : 'No account is linked yet. Linking sends you to the vendor to approve it.',
            }))
        : null,

      el('div.mm-row.mm-gap-2.mm-mt-5',
        integration.docsUrl
          ? el('a.mm-btn.mm-btn--ghost', {
              href: integration.docsUrl, target: '_blank', rel: 'noopener noreferrer',
              text: 'Their documentation',
            })
          : null,
        el('span.mm-grow'),
        el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) }),

        session.can('integrations.manage') && integration.oauth && !integration.oauth.connected
          ? el('button.mm-btn.mm-btn--outline', {
              type: 'button', text: 'Link an account', onClick: () => close({ action: 'oauth' }),
            })
          : null,
        session.can('integrations.manage') && integration.oauth?.connected
          ? el('button.mm-btn.mm-btn--ghost.mm-btn--danger-text', {
              type: 'button', text: 'Unlink', onClick: () => close({ action: 'unlink' }),
            })
          : null,
        session.can('integrations.view')
          ? el('button.mm-btn.mm-btn--primary', {
              type: 'button', text: 'Test the connection', onClick: () => close({ action: 'test' }),
            })
          : null)),
  });

  if (!result) return;

  if (result.action === 'test') return test(integration, reload);
  if (result.action === 'oauth') return startOAuth(integration);
  if (result.action === 'unlink') return unlink(integration, reload);
}

/**
 * Test a connection, and report what actually happened.
 *
 * "Not configured" is reported as its own outcome rather than as a failure:
 * they lead to different actions, and conflating them sends somebody looking
 * for a fault when the answer is "add the keys".
 */
async function test(integration, reload) {
  try {
    const { data } = await api.post(`/integrations/${integration.key}/test`, {});

    if (data.ok) {
      notify.success(data.message ?? `${integration.name} answered.`);
    } else if (data.status === 'not_configured') {
      notify.warning(
        `${integration.name} has no credentials on this deployment${data.missingKeys?.length ? `: ${data.missingKeys.join(', ')}` : ''}.`,
        { title: 'Not connected' });
    } else {
      notify.error(data.message ?? data.error ?? `${integration.name} rejected the credentials.`, {
        title: 'The vendor said no',
      });
    }
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function startOAuth(integration) {
  try {
    const { data } = await api.post(`/integrations/${integration.key}/oauth/start`, {
      redirectUri: `${window.location.origin}/settings/integrations`,
    });
    if (!data?.authorizationUrl) {
      notify.warning('The vendor did not return an authorisation page.');
      return;
    }
    // Leaving the application deliberately: the approval happens on the
    // vendor's own domain, which is the point of OAuth.
    window.location.href = data.authorizationUrl;
  } catch (err) {
    notifyError(err);
  }
}

async function unlink(integration, reload) {
  try {
    await api.delete(`/integrations/${integration.key}/oauth`);
    notify.success('Account unlinked.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
