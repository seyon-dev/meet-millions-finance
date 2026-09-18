/**
 * White-label branding.
 *
 * Changes are previewed live on this screen before they are saved, because
 * "does our green look right on a dark sidebar" is not a question anybody can
 * answer from a hex code.
 *
 * Only the two brand colours can be overridden. Surfaces, text and the status
 * palette stay as designed — a tenant picking a pale accent must not be able
 * to make their own staff's text unreadable.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, statusPill, pill, errorState, skeletonTable,
  notify, notifyError, banner, lockedState, promptText,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function brandingScreen() {
  setBreadcrumbs([{ label: 'Settings', href: '/settings' }, { label: 'Branding' }]);

  const page = el('div.mm-page');

  if (!session.hasFeature('white_label')) {
    page.append(
      pageHead({ title: 'Branding' }),
      lockedState({
        featureName: 'White-label branding',
        requiredAddOn: 'white_label_branding',
        message: 'Your own product name, colours, logo and domain — with the platform’s own name removed.',
      }));
    return page;
  }

  const bodyHost = el('div');
  render(bodyHost, skeletonTable(6, 2));

  async function load() {
    try {
      const { data } = await api.get('/branding');
      render(bodyHost, ...build(data, load));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Branding',
      subtitle: 'How the product looks to your staff and your clients.',
    }),
    bodyHost);

  await load();
  return page;
}

function build(data, reload) {
  const branding = data.branding ?? {};
  const canManage = session.can('settings.manage');

  const f = {};
  const input = (name, props = {}) => (f[name] = el('input.mm-input', {
    value: branding[name] ?? '',
    disabled: !canManage,
    ...props,
  }));

  const enabled = el('input.mm-checkbox', { type: 'checkbox', checked: !!branding.enabled, disabled: !canManage });
  const hidePowered = el('input.mm-checkbox', { type: 'checkbox', checked: !!branding.hidePoweredBy, disabled: !canManage });

  const primary = el('input.mm-colour', {
    type: 'color', value: branding.primaryColour ?? '#2F6BFF', disabled: !canManage,
  });
  const accent = el('input.mm-colour', {
    type: 'color', value: branding.accentColour ?? '#22D3EE', disabled: !canManage,
  });

  const sidebarStyle = el('select.mm-select', { disabled: !canManage },
    ...['glass', 'solid', 'minimal'].map(s => el('option', {
      value: s, selected: s === branding.sidebarStyle, text: fmt.label(s),
    })));

  const preview = el('div.mm-brandpreview');

  const paintPreview = () => {
    preview.style.setProperty('--preview-brand', primary.value);
    preview.style.setProperty('--preview-accent', accent.value);
    render(preview,
      el('div.mm-brandpreview__bar',
        el('span.mm-brandpreview__mark', { text: initialsOf(f.productName.value || 'Meet Millions') }),
        el('div',
          el('span.mm-brandpreview__name', { text: f.productName.value || 'Meet Millions' }),
          el('span.mm-brandpreview__sub', { text: session.session().tenant?.name ?? 'Your practice' }))),
      el('div.mm-brandpreview__body',
        el('span.mm-brandpreview__btn', { text: 'Primary action' }),
        el('span.mm-brandpreview__link', { text: 'A link' }),
        el('span.mm-brandpreview__pill', { text: 'Verified' })));
  };

  // Live: typing a name or dragging a colour repaints immediately.
  const productName = input('productName', {
    placeholder: 'Meridian Compliance',
    onInput: paintPreview,
  });
  primary.addEventListener('input', paintPreview);
  accent.addEventListener('input', paintPreview);

  const form = el('form.mm-form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const submitButton = form.querySelector('button[type=submit]');
      submitButton.disabled = true;
      try {
        const { data: saved } = await api.patch('/branding', {
          enabled: enabled.checked,
          productName: productName.value.trim() || undefined,
          primaryColour: primary.value,
          accentColour: accent.value,
          sidebarStyle: sidebarStyle.value,
          loginHeadline: f.loginHeadline.value.trim() || undefined,
          loginSubtext: f.loginSubtext.value.trim() || undefined,
          emailFromName: f.emailFromName.value.trim() || undefined,
          emailFromAddress: f.emailFromAddress.value.trim() || undefined,
          smsSenderId: f.smsSenderId.value.trim() || undefined,
          supportEmail: f.supportEmail.value.trim() || undefined,
          supportPhone: f.supportPhone.value.trim() || undefined,
          hidePoweredBy: hidePowered.checked,
        });
        // Applied at once, so the shell around this screen changes with it.
        session.applyBranding(saved?.branding ?? { enabled: enabled.checked, primaryColour: primary.value, accentColour: accent.value, productName: productName.value });
        notify.success('Saved.');
        await reload();
      } catch (err) {
        notifyError(err);
      } finally {
        submitButton.disabled = false;
      }
    },
  },
    el('label.mm-switch',
      enabled,
      el('span.mm-switch__text',
        el('span', { text: 'Use our own branding' }),
        el('span.mm-muted.mm-text-xs.mm-block', {
          text: 'Off, everybody sees the platform’s own name and colours.',
        }))),

    el('div.mm-field.mm-mt-4', el('label.mm-field__label', { text: 'Product name' }), productName),

    el('div.mm-grid.mm-grid-3.mm-gap-3',
      el('div.mm-field', el('label.mm-field__label', { text: 'Primary colour' }), primary),
      el('div.mm-field', el('label.mm-field__label', { text: 'Accent colour' }), accent),
      el('div.mm-field', el('label.mm-field__label', { text: 'Sidebar' }), sidebarStyle)),

    el('h3.mm-label.mm-mt-4', { text: 'The sign-in screen' }),
    el('div.mm-field', el('label.mm-field__label', { text: 'Headline' }),
      input('loginHeadline', { placeholder: 'Your filings, in one place.' })),
    el('div.mm-field', el('label.mm-field__label', { text: 'Subtext' }),
      input('loginSubtext', { placeholder: 'Upload, track and approve every return.' })),

    el('h3.mm-label.mm-mt-4', { text: 'How messages appear' }),
    el('div.mm-grid.mm-grid-2.mm-gap-3',
      el('div.mm-field', el('label.mm-field__label', { text: 'Email sender name' }),
        input('emailFromName', { placeholder: 'Meridian Compliance' })),
      el('div.mm-field', el('label.mm-field__label', { text: 'Email sender address' }),
        input('emailFromAddress', { type: 'email', placeholder: 'filings@meridian.example' }))),
    el('div.mm-grid.mm-grid-3.mm-gap-3',
      el('div.mm-field',
        el('label.mm-field__label', { text: 'SMS sender ID' }),
        input('smsSenderId', { maxlength: '11', placeholder: 'MERIDN' }),
        el('p.mm-field__hint', { text: 'Six characters, registered with your SMS provider.' })),
      el('div.mm-field', el('label.mm-field__label', { text: 'Support email' }),
        input('supportEmail', { type: 'email' })),
      el('div.mm-field', el('label.mm-field__label', { text: 'Support phone' }),
        input('supportPhone', { type: 'tel' }))),

    el('label.mm-switch.mm-mt-3',
      hidePowered,
      el('span.mm-switch__text',
        el('span', { text: 'Remove “Powered by” from client-facing pages' }))),

    canManage
      ? el('div.mm-row.mm-end.mm-mt-5',
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save branding' }))
      : null);

  paintPreview();

  return [
    branding.enabled
      ? null
      : banner({
          text: 'Branding is switched off, so everybody currently sees the platform’s own name and colours. The settings below take effect when you turn it on.',
          tone: 'info',
          icon: 'palette',
        }),

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      card({ title: 'Your branding', body: form }),
      el('div.mm-stack.mm-gap-4',
        card({
          title: 'Preview',
          subtitle: 'Live, before you save.',
          body: preview,
        }),
        logoCard(branding, canManage, reload),
        domainCard(data, canManage, reload))),
  ].filter(Boolean);
}

function initialsOf(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

/** The logo. Uploaded as a file; served back through the authorised file route. */
function logoCard(branding, canManage, reload) {
  const fileInput = el('input.mm-input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/svg+xml,image/webp',
    disabled: !canManage,
    onChange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const form = new FormData();
      form.append('file', file, file.name);
      try {
        await api.upload('/branding/logo', form);
        notify.success('Logo uploaded.');
        await session.load();
        await reload();
      } catch (err) {
        notifyError(err);
      }
    },
  });

  return card({
    title: 'Logo',
    body: frag(
      branding.logoKey
        ? el('div.mm-brandpreview__logo',
            el('img', {
              src: `/files/assets/logo/${session.session().tenant?.id}`,
              alt: 'Your logo',
            }))
        : el('p.mm-muted.mm-text-sm', { text: 'No logo uploaded. The product’s mark is used instead.' }),
      el('div.mm-field.mm-mt-3',
        el('label.mm-field__label', { text: 'Upload a new one' }),
        fileInput,
        el('p.mm-field__hint', { text: 'PNG, JPEG, SVG or WebP. A transparent background works best on both themes.' }))),
  });
}

/**
 * A custom domain.
 *
 * Verification is a real DNS lookup done by the server. Until it passes, the
 * domain is shown as pending — never as connected.
 */
function domainCard(data, canManage, reload) {
  const domain = data.customDomain;
  const dns = data.dnsProvider ?? {};

  return card({
    title: 'Custom domain',
    subtitle: domain ? domain.domain : 'Your clients see the platform’s address.',
    actions: canManage
      ? button(domain ? 'Change' : 'Set one up', {
          variant: 'ghost', size: 'sm',
          onClick: () => setDomain(reload),
        })
      : null,
    body: frag(
      !dns.configured
        ? banner({
            text: `DNS verification needs ${(dns.missingKeys ?? []).join(', ')} on the Worker. Without it a domain can be recorded but not verified.`,
            tone: 'warning',
            icon: 'plug',
          })
        : null,

      domain
        ? frag(
            el('div.mm-kvgrid',
              kv('Domain', domain.domain, { mono: true }),
              kv('Status', fmt.label(domain.status)),
              kv('Verified', domain.verifiedAt ? fmt.dateTime(domain.verifiedAt) : 'Not yet')),

            domain.status !== 'verified' && domain.dnsRecord
              ? frag(
                  el('h3.mm-label.mm-mt-3', { text: 'Add this record with your DNS provider' }),
                  el('pre.mm-code', {
                    text: `${domain.dnsRecord.type}  ${domain.dnsRecord.name}  ${domain.dnsRecord.value}`,
                  }),
                  canManage
                    ? el('div.mm-row.mm-mt-3',
                        button('Check it now', {
                          variant: 'outline', size: 'sm',
                          onClick: () => verifyDomain(reload),
                        }))
                    : null)
              : null)
        : el('p.mm-muted.mm-text-sm', {
            text: 'A custom domain lets your clients reach the portal at your own address.',
          })),
  });
}

async function setDomain(reload) {
  const domain = await promptText({
    title: 'Custom domain',
    message: 'Enter the address your clients should use. You will be given a DNS record to add.',
    label: 'Domain',
    placeholder: 'portal.meridian.example',
    multiline: false,
    confirmLabel: 'Save',
  });
  if (!domain) return;

  try {
    const { data } = await api.post('/branding/domain', { domain });
    notify.success(data?.message ?? 'Domain recorded. Add the DNS record, then verify it.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function verifyDomain(reload) {
  try {
    const { data } = await api.post('/branding/domain/verify', {});
    if (data?.verified) notify.success('Verified. Your clients can use it now.');
    else notify.warning(data?.reason ?? 'The record is not visible yet. DNS can take a few hours.', {
      title: 'Not verified',
    });
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
