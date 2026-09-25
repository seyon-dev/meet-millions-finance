/**
 * Settings.
 *
 * A hub rather than a single long page: each area is its own screen with its
 * own permission, so somebody who may change notification templates does not
 * have to be trusted with the security policy.
 *
 * Only the cards the signed-in person can actually open are shown; a settings
 * page full of doors that will not open is worse than a short one.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, pill, errorState, skeletonTiles,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

const AREAS = [
  {
    title: 'Your profile', path: '/settings/profile', icon: 'user',
    description: 'Your name, how you are reached, and how this looks.',
  },
  {
    title: 'Password', path: '/settings/password', icon: 'key',
    description: 'Change the password you sign in with.',
  },
  {
    title: 'Your security', path: '/settings/security', icon: 'shield',
    description: 'Two-factor, your active sessions, and where you have signed in from.',
  },
  {
    title: 'Notifications', path: '/settings/notifications', icon: 'bell',
    description: 'What the product tells you about, and through which channel.',
  },
  {
    title: 'Security policy', path: '/settings/security', icon: 'lock',
    permission: 'settings.manage',
    description: 'Password rules, session length, IP allowlist and enforced two-factor.',
  },
  {
    title: 'Team', path: '/team', icon: 'users-round',
    permission: 'users.view',
    description: 'People, roles and permission exceptions.',
  },
  {
    title: 'Branches', path: '/settings/branches', icon: 'map-pin',
    permission: 'branches.view',
    description: 'Offices, their managers and their geofences.',
  },
  {
    title: 'Companies', path: '/companies', icon: 'building',
    permission: 'companies.view',
    description: 'The registrations your clients file under.',
  },
  {
    title: 'Integrations', path: '/settings/integrations', icon: 'plug',
    permission: 'integrations.view',
    description: 'Every vendor this deployment can talk to, and what each still needs.',
  },
  {
    title: 'Branding', path: '/settings/branding', icon: 'palette',
    permission: 'settings.manage',
    feature: 'white_label',
    description: 'Your own name, colours, logo and domain on the product.',
  },
  {
    title: 'API keys', path: '/settings/api', icon: 'terminal',
    permission: 'api.view',
    feature: 'api_access',
    description: 'Keys for your own integrations, with their scopes and usage.',
  },
  {
    title: 'Backup and restore', path: '/settings/backup', icon: 'database',
    permission: 'settings.manage',
    description: 'Export everything, and verify that an export is readable.',
  },
  {
    title: 'Subscription', path: '/billing/subscription', icon: 'credit-card',
    permission: 'subscriptions.manage',
    description: 'Your plan, your usage against its limits, and the add-ons you run.',
  },
  {
    title: 'Audit trail', path: '/audit', icon: 'scroll-text',
    permission: 'audit.view',
    description: 'Every consequential action, hash-chained and verifiable.',
  },
];

export default async function settingsScreen() {
  setBreadcrumbs([{ label: 'Settings' }]);

  const page = el('div.mm-page');
  const orgHost = el('div');

  // The platform owner belongs to no organisation: every organisation area
  // below would open onto nothing. Their own account is what they manage here.
  const platformOnly = session.isPlatformOnly();
  const PERSONAL = new Set(['/settings/profile', '/settings/password']);
  const visible = platformOnly
    ? AREAS.filter(area => PERSONAL.has(area.path) || area.title === 'Your security')
    : AREAS.filter(area => !area.permission || session.can(area.permission));

  page.append(
    pageHead({
      title: 'Settings',
      subtitle: platformOnly
        ? 'Your platform owner account: name, sign-in email, password and two-factor.'
        : 'Your own preferences, and — where you have the permission — the organisation’s.',
    }),
    orgHost,
    el('div.mm-grid.mm-grid-3.mm-gap-4',
      ...visible.map(area => areaCard(area))));

  if (!platformOnly) {
    render(orgHost, skeletonTiles(1));
    loadOrganisation(orgHost);
  }

  return page;
}

function areaCard(area) {
  const locked = area.feature && !session.hasFeature(area.feature);

  return el('a.mm-card.mm-card--interactive.mm-settings-card', {
    href: locked ? '/marketplace' : area.path,
    title: locked ? `${area.title} is not included in your plan` : area.title,
  },
    el('div.mm-card__body',
      el('div.mm-row.mm-gap-3.mm-center',
        el('span.mm-settings-card__icon', icon(area.icon)),
        el('div.mm-stack',
          el('span.mm-fw-medium', { text: area.title }),
          el('span.mm-muted.mm-text-xs', { text: area.description })),
        locked ? icon('lock', { size: 'sm', className: 'mm-muted' }) : null)));
}

/**
 * The organisation's own settings.
 *
 * Every namespace the server declares, rendered from that declaration — the
 * screen cannot offer a setting the server does not know about, and a new
 * setting appears here the moment it is added on the server.
 */
async function loadOrganisation(host) {
  if (!session.can('settings.view')) { render(host); return; }

  try {
    const { data } = await api.get('/settings');
    const namespaces = Object.entries(data.namespaces ?? {});
    const canManage = session.can('settings.manage');
    const state = session.session();
    const upload = data.uploadLimits ?? {};

    const inputs = new Map();

    const groups = namespaces.map(([namespace, settings]) => el('details.mm-details.mm-settings-group', {
      open: namespace === 'general',
    },
      el('summary', { text: `${fmt.label(namespace)} — ${fmt.plural(settings.length, 'setting')}` }),
      el('div.mm-grid.mm-grid-2.mm-gap-3.mm-mt-3',
        ...settings.map((setting) => {
          const input = settingInput(setting, canManage);
          inputs.set(`${namespace}.${setting.key}`, { namespace, setting, input });

          return setting.type === 'boolean'
            ? el('label.mm-switch',
                input,
                el('span.mm-switch__text',
                  el('span', { text: setting.label }),
                  setting.isSet
                    ? null
                    : el('span.mm-muted.mm-text-xs.mm-block', { text: 'Not set — the default applies.' })))
            : el('div.mm-field',
                el('label.mm-field__label', { text: setting.label }),
                input,
                setting.isSet
                  ? el('p.mm-field__hint', { text: `Changed ${fmt.relative(setting.updatedAt)}` })
                  : el('p.mm-field__hint', { text: 'Not set — the default applies.' }));
        }))));

    const form = el('form.mm-form', {
      novalidate: true,
      onSubmit: async (e) => {
        e.preventDefault();
        const submitButton = form.querySelector('button[type=submit]');
        submitButton.disabled = true;

        // Only what was actually filled in is sent. Sending every key would
        // write an explicit value over every default the organisation never
        // chose to change.
        const settings = [];
        for (const { namespace, setting, input } of inputs.values()) {
          const value = setting.type === 'boolean'
            ? input.checked
            : (setting.type === 'int' || setting.type === 'number')
              ? (input.value === '' ? null : Number(input.value))
              : input.value.trim();
          if (value === null || value === '') continue;
          settings.push({ namespace, key: setting.key, value });
        }

        try {
          const { data: result } = await api.put('/settings', { settings });
          if (result?.rejected?.length) {
            notify.warning(
              `${result.rejected[0].key}: ${result.rejected[0].reason}`,
              { title: `${result.rejected.length} not saved` });
          }
          notify.success(`${fmt.plural(result?.applied?.length ?? settings.length, 'setting')} saved.`);
        } catch (err) {
          notifyError(err);
        } finally {
          submitButton.disabled = false;
        }
      },
    },
      ...groups,
      canManage
        ? el('div.mm-row.mm-end.mm-mt-4',
            el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save settings' }))
        : null);

    render(host, card({
      title: state.tenant?.name ?? 'Your organisation',
      subtitle: [state.tenant?.gstin, state.plan?.name ? `${state.plan.name} plan` : null]
        .filter(Boolean).join(' · '),
      className: 'mm-mb-4',
      body: frag(
        el('div.mm-kvgrid.mm-mb-4',
          kv('GSTIN', state.tenant?.gstin, { mono: true }),
          kv('State', state.tenant?.stateCode, { mono: true }),
          kv('Currency', state.tenant?.currency),
          kv('Timezone', state.tenant?.timezone),
          kv('Upload limit', upload.maxBytes ? fmt.bytes(upload.maxBytes) : null),
          kv('Files per upload', upload.maxFilesPerUpload)),
        form),
    }));
  } catch (err) {
    render(host, errorState(err));
  }
}

function settingInput(setting, canManage) {
  if (setting.type === 'boolean') {
    return el('input.mm-checkbox', { type: 'checkbox', checked: !!setting.value, disabled: !canManage });
  }
  if (setting.values?.length) {
    return el('select.mm-select', { disabled: !canManage },
      el('option', { value: '', text: 'Use the default' }),
      ...setting.values.map(value => el('option', {
        value, selected: value === setting.value, text: fmt.label(String(value)),
      })));
  }
  return el('input.mm-input', {
    type: (setting.type === 'int' || setting.type === 'number') ? 'number' : 'text',
    value: setting.value ?? '',
    min: setting.min ?? null,
    max: setting.max ?? null,
    disabled: !canManage,
  });
}
