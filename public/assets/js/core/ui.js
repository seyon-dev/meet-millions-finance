/**
 * Shared interface pieces: toasts, modals, drawers, menus, empty and error
 * states, and the small building blocks every screen assembles from.
 *
 * All of them are plain functions returning elements. There is no component
 * framework here, and none is needed — the screens are data-driven and the
 * data comes from one request each.
 */

import { el, render, frag, focusFirst, trapFocus } from './dom.js';
import { icon } from './icons.js';
import * as fmt from './format.js';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
let toastHost = null;

function ensureToastHost() {
  if (!toastHost) {
    toastHost = el('div.mm-toast-host', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  return toastHost;
}

const TOAST_ICONS = {
  success: 'check-circle', error: 'x-circle', warning: 'alert', info: 'info',
};

/**
 * A toast.
 *
 * Errors stay until dismissed. A message telling somebody their save failed
 * should not vanish while they are reading it.
 */
export function toast(message, { type = 'info', title = null, timeout = null, action = null } = {}) {
  const host = ensureToastHost();
  const life = timeout ?? (type === 'error' ? 0 : 4500);

  const node = el('div.mm-toast', { class: `mm-toast--${type}` },
    el('span.mm-toast__icon', icon(TOAST_ICONS[type] ?? 'info')),
    el('div.mm-toast__body',
      title ? el('p.mm-toast__title', { text: title }) : null,
      el('p.mm-toast__msg', { text: message }),
      action
        ? el('button.mm-btn.mm-btn--xs.mm-btn--ghost', {
            type: 'button', text: action.label,
            onClick: () => { action.onClick?.(); dismiss(); },
          })
        : null),
    el('button.mm-toast__close', {
      type: 'button', 'aria-label': 'Dismiss', onClick: () => dismiss(),
    }, icon('x', { size: 'sm' })));

  function dismiss() {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-6px)';
    setTimeout(() => node.remove(), 180);
  }

  host.append(node);
  if (life > 0) setTimeout(dismiss, life);
  return { dismiss, node };
}

export const notify = {
  success: (m, o) => toast(m, { ...o, type: 'success' }),
  error: (m, o) => toast(m, { ...o, type: 'error' }),
  warning: (m, o) => toast(m, { ...o, type: 'warning' }),
  info: (m, o) => toast(m, { ...o, type: 'info' }),
};

/** Turn an API error into a toast, using what the error already knows. */
export function notifyError(err, fallback = 'That could not be completed.') {
  if (!err) return notify.error(fallback);
  if (err.name === 'AbortError') return null;

  if (err.name === 'FeatureLocked') {
    return notify.warning(err.message, {
      title: 'Not included in your plan',
      action: { label: 'See plans', onClick: () => { window.location.href = '/marketplace'; } },
    });
  }
  if (err.name === 'NotConfigured') {
    return notify.warning(err.message, { title: 'Not connected' });
  }
  if (err.name === 'ValidationError') {
    const first = Object.values(err.fields ?? {})[0];
    return notify.error(first ?? err.message, { title: 'Check the form' });
  }
  return notify.error(err.message ?? fallback, {
    title: null,
    // The request id is what support needs to find the log line.
    ...(err.requestId ? { action: { label: 'Copy reference', onClick: () => navigator.clipboard?.writeText(err.requestId) } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
let modalHost = null;

function ensureModalHost() {
  if (!modalHost) {
    // Born hidden. The host is a fixed, full-viewport layer; the [hidden]
    // rule in components.css was always written for it, but nothing ever
    // toggled the attribute — so after the first dialog closed, an empty
    // invisible layer sat over the whole application and swallowed every
    // click from then on. Keyboard users could carry on, which is exactly
    // why it survived: the app looked alive and was dead to the mouse.
    modalHost = el('div.mm-modal-host', { hidden: true });
    document.body.append(modalHost);
  }
  return modalHost;
}

/**
 * Open a modal.
 *
 * Returns a promise resolving to whatever `close(value)` is called with, so a
 * caller can `await` a dialog and read the answer as a value rather than
 * threading callbacks through.
 */
export function modal({
  title, description = null, body, footer = null, size = null,
  dismissible = true, onOpen = null,
}) {
  const host = ensureModalHost();

  return new Promise((resolve) => {
    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      releaseTrap();
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      if (!host.children.length) {
        document.body.classList.remove('mm-scroll-lock');
        host.hidden = true;
      }
      previouslyFocused?.focus?.();
      resolve(value);
    };

    const content = typeof body === 'function' ? body({ close }) : body;
    const footerNode = typeof footer === 'function' ? footer({ close }) : footer;

    const dialog = el('div.mm-modal', {
      class: size ? `mm-modal--${size}` : '',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    },
      el('header.mm-modal__header',
        el('div',
          el('h2.mm-modal__title', { text: title }),
          description ? el('p.mm-modal__desc', { text: description }) : null),
        dismissible
          ? el('button.mm-modal__close', {
              type: 'button', 'aria-label': 'Close', onClick: () => close(null),
            }, icon('x'))
          : null),
      el('div.mm-modal__body', content),
      footerNode ? el('footer.mm-modal__footer', footerNode) : null);

    const wrap = el('div',
      el('div.mm-modal__backdrop', {
        onClick: () => { if (dismissible) close(null); },
      }),
      dialog);

    const previouslyFocused = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) { e.preventDefault(); close(null); }
    };

    host.hidden = false;
    host.append(wrap);
    document.body.classList.add('mm-scroll-lock');
    document.addEventListener('keydown', onKey);
    const releaseTrap = trapFocus(dialog);
    focusFirst(dialog);
    onOpen?.({ close, dialog });
  });
}

/**
 * A confirmation.
 *
 * `confirmText` can be a string the person must type — used for the handful of
 * actions that cannot be undone, where a single click is too little friction.
 */
export function confirm({
  title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  tone = 'primary', confirmText = null, detail = null,
}) {
  return modal({
    title,
    size: 'sm',
    body: ({ close }) => {
      let typed = '';
      const button = el('button.mm-btn', {
        class: tone === 'danger' ? 'mm-btn--danger' : 'mm-btn--primary',
        type: 'button',
        disabled: !!confirmText,
        text: confirmLabel,
        onClick: () => close(true),
      });

      const input = confirmText
        ? el('input.mm-input', {
            type: 'text',
            placeholder: confirmText,
            'aria-label': `Type ${confirmText} to confirm`,
            onInput: (e) => {
              typed = e.target.value;
              button.disabled = typed.trim() !== confirmText;
            },
          })
        : null;

      return frag(
        el('p', { text: message }),
        detail ? el('p.mm-muted.mm-text-sm', { text: detail }) : null,
        confirmText
          ? el('div.mm-field',
              el('label.mm-field__label', { text: `Type “${confirmText}” to confirm` }),
              input)
          : null,
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-5',
          el('button.mm-btn.mm-btn--ghost', {
            type: 'button', text: cancelLabel, onClick: () => close(false),
          }),
          button));
    },
  });
}

/**
 * Ask for a line or two of text.
 *
 * Resolves to the trimmed string, or null if it was cancelled. Used wherever
 * the API requires a reason — a rejection, a plan change, a suspension — so
 * the reason is asked for in the product's own dialog rather than the
 * browser's, which cannot be styled, labelled or made required.
 */
export function promptText({
  title, message = null, label = 'Reason', placeholder = '', confirmLabel = 'Save',
  required = true, multiline = true, tone = 'primary', maxlength = 2000, value = '',
  inputType = 'text',
}) {
  return modal({
    title,
    size: 'sm',
    body: ({ close }) => {
      const input = multiline
        ? el('textarea.mm-input.mm-textarea', { rows: '4', placeholder, maxlength: String(maxlength), value })
        : el('input.mm-input', { type: inputType, placeholder, maxlength: String(maxlength), value });

      const errorHost = el('div');
      const form = el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (required && !text) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: `${label} is required.` }));
            input.focus();
            return;
          }
          close(text);
        },
      },
        message ? el('p.mm-mb-3', { text: message }) : null,
        el('div.mm-field',
          el('label.mm-field__label', { text: label }),
          input,
          errorHost),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn', {
            class: tone === 'danger' ? 'mm-btn--danger' : 'mm-btn--primary',
            type: 'submit', text: confirmLabel,
          })));

      return form;
    },
  });
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------
let drawerHost = null;

/** A right-hand drawer — for detail panes that should not lose the list. */
export function drawer({ title, subtitle = null, body, footer = null, wide = false }) {
  if (!drawerHost) {
    drawerHost = el('div.mm-drawer-host');
    document.body.append(drawerHost);
  }

  return new Promise((resolve) => {
    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      releaseTrap();
      document.removeEventListener('keydown', onKey);
      panel.classList.remove('is-open');
      setTimeout(() => {
        wrap.remove();
        if (!drawerHost.children.length) document.body.classList.remove('mm-scroll-lock');
      }, 200);
      resolve(value);
    };

    const content = typeof body === 'function' ? body({ close }) : body;
    const footerNode = typeof footer === 'function' ? footer({ close }) : footer;

    const panel = el('aside.mm-drawer', {
      class: wide ? 'mm-drawer--wide' : '', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    },
      el('header.mm-drawer__header',
        el('div',
          el('h2.mm-modal__title', { text: title }),
          subtitle ? el('p.mm-modal__desc', { text: subtitle }) : null),
        el('button.mm-modal__close', {
          type: 'button', 'aria-label': 'Close', onClick: () => close(null),
        }, icon('x'))),
      el('div.mm-drawer__body', content),
      footerNode ? el('footer.mm-drawer__footer', footerNode) : null);

    const wrap = el('div',
      el('div.mm-drawer__backdrop', { onClick: () => close(null) }),
      panel);

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };

    drawerHost.append(wrap);
    document.body.classList.add('mm-scroll-lock');
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => panel.classList.add('is-open'));
    const releaseTrap = trapFocus(panel);
    focusFirst(panel);
  });
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * An empty state.
 *
 * Always says what would fill it, and offers the action that would. "No data"
 * on its own tells somebody nothing they did not already know.
 */
export function emptyState({ title, message = null, icon: iconName = 'inbox', action = null, inline = false }) {
  return el('div.mm-state', { class: inline ? 'mm-state--inline' : '' },
    el('div.mm-state__art', icon(iconName, { size: 'xl' })),
    el('p.mm-state__title', { text: title }),
    message ? el('p.mm-state__msg', { text: message }) : null,
    action
      ? el('div.mm-state__actions',
          el('button.mm-btn.mm-btn--primary', {
            type: 'button', text: action.label, onClick: action.onClick,
          }))
      : null);
}

/** An error state, with a retry where retrying could plausibly help. */
export function errorState(err, { onRetry = null } = {}) {
  const isNetwork = err?.code === 'network_error';
  return el('div.mm-state.mm-state--error',
    el('div.mm-state__art', icon(isNetwork ? 'refresh' : 'alert', { size: 'xl' })),
    el('p.mm-state__title', { text: isNetwork ? 'Could not reach the server' : 'Something went wrong' }),
    el('p.mm-state__msg', { text: err?.message ?? 'Please try again.' }),
    err?.requestId
      ? el('p.mm-muted.mm-text-xs', { text: `Reference: ${err.requestId}` })
      : null,
    onRetry
      ? el('div.mm-state__actions',
          el('button.mm-btn.mm-btn--outline', { type: 'button', text: 'Try again', onClick: onRetry }))
      : null);
}

/**
 * A locked state for a plan or add-on gate.
 *
 * Shown in place of the screen's content, never instead of the screen: the
 * navigation item stays, so somebody can see what the product does before
 * deciding whether to pay for it.
 */
export function lockedState({ featureName, requiredPlan = null, requiredAddOn = null, message = null }) {
  return el('div.mm-state.mm-state--locked',
    el('div.mm-state__art', icon('lock', { size: 'xl' })),
    el('p.mm-state__title', { text: `${featureName} is not in your plan` }),
    el('p.mm-state__msg', {
      text: message ?? (requiredAddOn
        ? 'This is an add-on module. Activating it turns this screen on immediately.'
        : `This is included from the ${fmt.label(requiredPlan ?? 'next')} plan upward.`),
    }),
    el('div.mm-state__actions',
      el('a.mm-btn.mm-btn--primary', {
        href: requiredAddOn ? `/marketplace?addon=${requiredAddOn}` : '/billing/subscription',
        text: requiredAddOn ? 'See this add-on' : 'Compare plans',
      })));
}

/** Skeleton rows — shown while a list loads, sized like the real thing. */
export function skeletonTable(rows = 6, columns = 5) {
  return el('div.mm-card',
    el('div.mm-card__body',
      ...Array.from({ length: rows }, () => el('div.mm-row.mm-gap-3.mm-mb-3',
        ...Array.from({ length: columns }, (_, i) => el('span.mm-skeleton.mm-skeleton--line', {
          style: { flex: i === 0 ? '2' : '1' },
        }))))));
}

export function skeletonTiles(count = 4) {
  return el('div.mm-grid.mm-grid-4.mm-gap-4',
    ...Array.from({ length: count }, () => el('div.mm-skeleton.mm-skeleton--stat')));
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** The tone a status word should be shown in. */
export function statusTone(status) {
  const value = String(status ?? '').toLowerCase();
  if (['verified', 'approved', 'paid', 'active', 'completed', 'success', 'resolved', 'signed', 'connected', 'filed', 'won', 'present'].includes(value)) return 'success';
  if (['rejected', 'failed', 'overdue', 'suspended', 'breached', 'declined', 'lost', 'disputed', 'error', 'absent'].includes(value)) return 'danger';
  if (['pending', 'query_raised', 'awaiting_client', 'waiting_client', 'under_review', 'in_progress', 'partially_paid', 'trialing', 'trial', 'draft', 'running', 'sent', 'scheduled'].includes(value)) return 'warning';
  if (['submitted', 'collecting', 'new', 'open', 'initiated', 'ringing', 'queued'].includes(value)) return 'info';
  return 'neutral';
}

export function pill(text, tone = 'neutral', { live = false } = {}) {
  return el('span.mm-pill', {
    class: `mm-pill--${tone}${live ? ' mm-pill--live' : ''}`,
    text: fmt.label(text),
  });
}

export function statusPill(status) {
  return pill(status, statusTone(status));
}

export function avatar(name, { size = null, key = null } = {}) {
  const node = el('span.mm-avatar', {
    class: size ? `mm-avatar--${size}` : '',
    title: name ?? '',
    'aria-hidden': 'true',
  });
  if (key) {
    node.append(el('img', { src: key, alt: '' }));
  } else {
    node.textContent = fmt.initials(name);
  }
  return node;
}

/** A stat tile. `delta` is a signed percentage against the previous period. */
/**
 * Count a numeric text up from zero, honouring the person's reduced-motion
 * preference and any prefix/suffix (so ₹1,23,456.00 stays a rupee amount the
 * whole way). Non-numeric values render as they are.
 */
export function countUp(node, text, { duration = 800 } = {}) {
  const raw = String(text ?? '');
  const match = raw.match(/^([^0-9-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
  let reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* assume motion */ }
  const target = match ? Number(match[2].replace(/,/g, '')) : NaN;
  if (!match || reduced || !Number.isFinite(target) || target === 0 || Math.abs(target) > 1e12) {
    node.textContent = raw;
    return;
  }
  const [, prefix, num, suffix] = match;
  const decimals = (num.split('.')[1] ?? '').length;
  const grouped = num.includes(',');
  const t0 = performance.now();
  const frame = (t) => {
    const p = Math.min(1, (t - t0) / duration);
    const eased = 1 - (1 - p) ** 3;
    const current = target * eased;
    node.textContent = prefix + (grouped
      ? current.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : current.toFixed(decimals)) + suffix;
    if (p < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export function stat({ label: title, value, caption = null, delta = null, tone = null, icon: iconName = null, href = null, hero = false }) {
  const valueNode = el('p.mm-stat__value');
  countUp(valueNode, String(value ?? '—'));
  const body = el('div.mm-stat', { class: [tone ? `mm-stat--${tone}` : '', hero ? 'mm-stat--hero' : ''].filter(Boolean).join(' ') },
    el('div.mm-stat__meta',
      el('span.mm-stat__label', { text: title }),
      iconName ? icon(iconName, { size: 'sm' }) : null),
    valueNode,
    caption || delta !== null
      ? el('div.mm-stat__caption',
          delta === null || delta === undefined
            ? null
            : el('span.mm-stat__delta', {
                class: delta > 0 ? 'mm-stat__delta--up' : delta < 0 ? 'mm-stat__delta--down' : 'mm-stat__delta--flat',
                text: `${delta > 0 ? '+' : ''}${delta}%`,
              }),
          caption ? el('span', { text: caption }) : null)
      : null);

  return href ? el('a.mm-stat-link', { href }, body) : body;
}

/** A labelled value, for detail panes. */
export function kv(key, value, { mono = false } = {}) {
  return el('div.mm-kv',
    el('span.mm-kv__k', { text: key }),
    el('span.mm-kv__v', { class: mono ? 'mm-mono' : '', text: value === null || value === undefined || value === '' ? '—' : String(value) }));
}

/** A page header: title, optional subtitle, and actions on the right. */
export function pageHead({ title, subtitle = null, actions = null, breadcrumbs = null }) {
  return el('header.mm-pagehead',
    el('div.mm-pagehead__main',
      breadcrumbs ? breadcrumbs : null,
      el('h1.mm-pagehead__title', { text: title }),
      subtitle ? el('p.mm-pagehead__sub', { text: subtitle }) : null),
    actions ? el('div.mm-pagehead__actions', actions) : null);
}

export function card({ title = null, subtitle = null, actions = null, body, footer = null, className = '', flush = false }) {
  return el('section.mm-card', { class: className },
    title || actions
      ? el('header.mm-card__header',
          el('div',
            title ? el('h2.mm-card__title', { text: title }) : null,
            subtitle ? el('p.mm-card__subtitle', { text: subtitle }) : null),
          actions ? el('div.mm-row.mm-gap-2', actions) : null)
      : null,
    el('div.mm-card__body', { class: flush ? 'mm-card__body--flush' : '' }, body),
    footer ? el('footer.mm-card__footer', footer) : null);
}

export function button(label, { variant = 'secondary', size = null, icon: iconName = null, onClick = null, type = 'button', disabled = false, href = null, title = null } = {}) {
  const classes = ['mm-btn', `mm-btn--${variant}`, size ? `mm-btn--${size}` : ''].filter(Boolean).join(' ');
  const children = [iconName ? icon(iconName, { size: 'sm' }) : null, label ? el('span', { text: label }) : null];

  return href
    ? el('a', { class: classes, href, title }, ...children)
    : el('button', { class: classes, type, disabled, title, onClick }, ...children);
}

export function iconButton(iconName, { label, onClick = null, href = null, variant = null, badge = null } = {}) {
  const children = [icon(iconName), badge ? el('span.mm-iconbtn__badge', { text: String(badge) }) : null];
  const classes = ['mm-iconbtn', variant ? `mm-iconbtn--${variant}` : ''].filter(Boolean).join(' ');
  return href
    ? el('a', { class: classes, href, 'aria-label': label, title: label }, ...children)
    : el('button', { class: classes, type: 'button', 'aria-label': label, title: label, onClick }, ...children);
}

/** A banner — a persistent notice at the top of a screen. */
export function banner({ text, tone = 'info', icon: iconName = null, action = null }) {
  return el('div.mm-banner', { class: `mm-banner--${tone}` },
    el('span.mm-banner__icon', icon(iconName ?? TOAST_ICONS[tone] ?? 'info')),
    el('p', { text }),
    action
      ? (action.href
          ? el('a.mm-btn.mm-btn--xs.mm-btn--ghost', { href: action.href, text: action.label })
          : el('button.mm-btn.mm-btn--xs.mm-btn--ghost', { type: 'button', text: action.label, onClick: action.onClick }))
      : null);
}

export { el, render, frag };
