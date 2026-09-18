/**
 * The call widget — incoming-call popup and active-call bar.
 *
 * Both are global on purpose. A call arrives while somebody is verifying a
 * document, and it has to be answerable without leaving that screen; an active
 * call has to stay controllable while they carry on working. Putting either
 * inside the calls screen would mean the only way to take a call is to already
 * be looking at the calls screen, which is not how a phone works.
 *
 * The styles for both existed from the start (`.mm-incoming`, `.mm-callbar` in
 * screens.css). Nothing rendered them — this is that missing piece.
 *
 * It polls `/api/calls/live`, which is also the endpoint that reconciles a
 * call ended on the handset, so a call that disappears there disappears here.
 */

import { el, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as session from '../core/session.js';
import { notify, notifyError } from '../core/ui.js';

/** Statuses the API treats as live, mirrored so the widget agrees with it. */
const RINGING = ['ringing', 'initiated'];
const ACTIVE = ['in_progress', 'on_hold'];

const POLL_IDLE_MS = 15000;   // nothing happening — a slow heartbeat
const POLL_LIVE_MS = 3000;    // a call is up — keep the timer and state honest

let host = null;
let timer = null;
let tick = null;
let current = null;          // the call the bar is showing
let dismissed = new Set();   // calls this person has already declined

/**
 * Start polling. Safe to call more than once; later calls are ignored.
 * Does nothing at all when the person cannot see calls, or the plan has no
 * telephony — no polling, no DOM, no wasted requests.
 */
export function mountCallWidget() {
  if (host) return;
  if (!session.isSignedIn()) return;
  // The platform owner has the permission but no organisation, so there is
  // never a call to show. Polling from there is pure waste.
  if (session.isPlatformOnly()) return;
  if (!session.canAny('calls.view', 'calls.view.own')) return;
  if (!session.hasFeature('cloud_telephony')) return;

  host = el('div.mm-call-widget');
  document.body.append(host);

  poll();
  schedule(POLL_IDLE_MS);

  // A tab nobody is looking at does not need a 3-second poll.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(timer); timer = null; }
    else if (!timer) { poll(); schedule(current ? POLL_LIVE_MS : POLL_IDLE_MS); }
  });
}

export function unmountCallWidget() {
  clearTimeout(timer);
  clearInterval(tick);
  timer = null;
  tick = null;
  current = null;
  dismissed = new Set();
  host?.remove();
  host = null;
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(async () => { await poll(); schedule(current ? POLL_LIVE_MS : POLL_IDLE_MS); }, ms);
}

async function poll() {
  if (!host) return;
  try {
    const { data } = await api.get('/calls/live');
    paint(data?.calls ?? data ?? []);
  } catch (err) {
    // A failed poll is not worth a toast on every heartbeat — the widget simply
    // shows nothing until the next one succeeds. A lost session is handled by
    // the API client, which signs out.
    if (err.name === 'AuthError') unmountCallWidget();
  }
}

function paint(calls) {
  const mine = calls.filter(c => !dismissed.has(c.id));

  const active = mine.find(c => ACTIVE.includes(c.status));
  const ringing = mine.find(c => RINGING.includes(c.status) && c.direction === 'inbound');

  // An active call outranks a ringing one: you cannot answer a second call
  // while on the first, and showing both is noise.
  if (active) {
    current = active;
    render(host, callBar(active));
    startTimer(active);
    return;
  }

  if (ringing) {
    current = null;
    clearInterval(tick);
    render(host, incoming(ringing));
    return;
  }

  current = null;
  clearInterval(tick);
  render(host);
}

// ---------------------------------------------------------------------------
// Incoming
// ---------------------------------------------------------------------------

function incoming(call) {
  const who = call.clientName ?? call.fromNumber ?? 'Unknown number';

  return el('div.mm-incoming', { role: 'alertdialog', 'aria-label': `Incoming call from ${who}` },
    el('span.mm-incoming__ring', { 'aria-hidden': 'true' }),

    el('div.mm-row.mm-gap-3',
      el('span.mm-livedot', { 'aria-hidden': 'true' }),
      el('div.mm-stack.mm-grow',
        el('span.mm-muted.mm-text-xs', { text: 'Incoming call' }),
        el('span.mm-fw-medium', { text: who }),
        el('span.mm-muted.mm-text-xs', {
          text: [call.fromNumber, call.clientCode].filter(Boolean).join(' · '),
        }))),

    // Only shown when the number matched a client record — an unmatched call
    // gets no invented context.
    call.clientId
      ? el('a.mm-link.mm-text-xs', { href: `/clients/${call.clientId}`, text: 'Open the client record' })
      : el('span.mm-muted.mm-text-xs', { text: 'This number is not on any client record.' }),

    el('div.mm-incoming__actions',
      el('button.mm-btn.mm-btn--ghost', {
        type: 'button',
        text: 'Decline',
        onClick: () => { dismissed.add(call.id); paint([]); },
      }),
      el('a.mm-btn.mm-btn--primary', {
        href: `/calls/${call.id}`,
        text: 'Open call',
      })));
}

// ---------------------------------------------------------------------------
// Active
// ---------------------------------------------------------------------------

function callBar(call) {
  const who = call.clientName ?? call.toNumber ?? call.fromNumber ?? 'Call in progress';
  const elapsed = el('span.mm-callbar__timer', { text: '0:00' });

  const control = (name, iconName, label, on = false) => el('button.mm-callctl', {
    type: 'button',
    class: on ? 'is-on' : '',
    'aria-label': label,
    title: label,
    onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.post(`/calls/${call.id}/control`, { action: name });
        await poll();
      } catch (err) {
        notifyError(err);
      } finally {
        btn.disabled = false;
      }
    },
  }, icon(iconName, { size: 'sm' }));

  return el('div.mm-callbar', { role: 'region', 'aria-label': 'Active call' },
    el('span.mm-livedot', { 'aria-hidden': 'true' }),
    el('div.mm-stack.mm-grow',
      el('span.mm-fw-medium', { text: who }),
      el('span.mm-muted.mm-text-xs', {
        text: [
          call.isOnHold ? 'On hold' : 'Connected',
          call.isRecording ? 'recording' : null,
          call.agentName,
        ].filter(Boolean).join(' · '),
      })),

    elapsed,

    el('div.mm-callbar__controls',
      control(call.isMuted ? 'unmute' : 'mute', call.isMuted ? 'mic-off' : 'mic',
        call.isMuted ? 'Unmute' : 'Mute', !!call.isMuted),
      control(call.isOnHold ? 'resume' : 'hold',
        call.isOnHold ? 'play' : 'pause',
        call.isOnHold ? 'Resume' : 'Hold', !!call.isOnHold),
      control(call.isRecording ? 'record_off' : 'record_on', 'mic',
        call.isRecording ? 'Stop recording' : 'Start recording', !!call.isRecording),
      el('a.mm-callctl', {
        href: `/calls/${call.id}`, 'aria-label': 'Open this call', title: 'Open this call',
      }, icon('maximize', { size: 'sm' })),
      el('button.mm-callctl.mm-callctl--end', {
        type: 'button',
        onClick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api.post(`/calls/${call.id}/control`, { action: 'hangup' });
            notify.success('Call ended.');
            await poll();
          } catch (err) {
            notifyError(err);
            e.currentTarget.disabled = false;
          }
        },
      }, icon('phone-off', { size: 'sm' }), el('span', { text: 'End' }))));
}

/**
 * Count up from when the call was answered.
 *
 * Driven from `answeredAt` rather than from a local counter, so the duration
 * survives a re-render and matches what the provider recorded.
 */
function startTimer(call) {
  clearInterval(tick);
  const started = call.answeredAt ?? call.startedAt;
  if (!started) return;

  const from = new Date(started).getTime();
  if (!Number.isFinite(from)) return;

  const paint = () => {
    const node = host?.querySelector('.mm-callbar__timer');
    if (!node) return;
    const seconds = Math.max(0, Math.floor((Date.now() - from) / 1000));
    const m = Math.floor(seconds / 60);
    node.textContent = `${m}:${String(seconds % 60).padStart(2, '0')}`;
  };

  paint();
  tick = setInterval(paint, 1000);
}
