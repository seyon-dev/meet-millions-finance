/**
 * Cloud calling.
 *
 * Four things on one screen because they are used together: the dial pad, the
 * calls currently live, the log of everything that has happened, and the
 * voicemails nobody has dealt with. Switching screens mid-call is exactly when
 * a person loses the thread of a conversation.
 *
 * When no telephony provider is configured this says so plainly and shows what
 * would be needed, rather than presenting a dial pad that silently does
 * nothing.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, kv, button, iconButton, statusPill, pill, avatar,
  emptyState, errorState, skeletonTiles, notify, notifyError, banner, modal, lockedState,
} from '../../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function callsScreen({ query }) {
  setBreadcrumbs([{ label: 'Calling' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(4));

  let settings;
  try {
    ({ data: settings } = await api.get('/calls/settings'));
  } catch (err) {
    if (err.name === 'FeatureLocked') {
      render(page,
        pageHead({ title: 'Cloud calling' }),
        lockedState({
          featureName: 'Cloud calling',
          requiredAddOn: 'cloud_telephony',
          message: 'Click-to-call, recording, IVR and call analytics, through your own telephony provider.',
        }));
      return page;
    }
    render(page, errorState(err));
    return page;
  }

  const connected = settings.settings.status === 'connected';
  const liveHost = el('div');
  const tabHost = el('div');
  const tableHost = el('div');

  let activeTab = query.get('tab') ?? 'log';

  page.replaceChildren();
  page.append(
    pageHead({
      title: 'Cloud calling',
      subtitle: connected
        ? `Connected through ${providerName(settings)}.`
        : 'Not connected to a telephony provider.',
      actions: frag(
        presenceControl(),
        session.can('calls.analytics')
          ? button('Analytics', { variant: 'ghost', icon: 'bar-chart', href: '/calls?tab=analytics' })
          : null,
        session.can('calls.configure')
          ? button('Settings', { variant: 'ghost', icon: 'settings', onClick: () => openSettings(settings) })
          : null),
    }),

    connected
      ? null
      : banner({
          text: `${providerName(settings)} is selected but ${settings.providers.find(p => p.key === settings.settings.provider)?.missingKeys?.join(', ') ?? 'its credentials'} are not set on this deployment, so no call can be placed or received.`,
          tone: 'warning',
          icon: 'plug',
          action: session.can('integrations.manage')
            ? { label: 'See what is needed', onClick: () => openSettings(settings) }
            : null,
        }),

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4', liveHost, tabHost, tableHost),
      el('div.mm-stack.mm-gap-4',
        dialPad(settings, connected),
        capabilitiesCard(settings),
        featuresCard(settings))));

  // ---- Live calls, polled -------------------------------------------------
  let liveTimer = null;

  async function paintLive() {
    try {
      const { data } = await api.get('/calls/live');
      const calls = data?.calls ?? [];
      render(liveHost, calls.length ? liveCard(calls, paintLive) : null);
    } catch {
      // A failed poll leaves whatever was there; the log below is unaffected.
    }
  }

  // Polled rather than pushed: a Worker holds no socket, and five seconds is
  // close enough for a screen somebody is watching during a call.
  await paintLive();
  liveTimer = setInterval(paintLive, 5000);
  // The router dispatches mm:teardown to the outgoing screen on navigation.
  // The old extra listener on mm:navigated cleared this interval immediately
  // — that event also fires for the navigation that loads this screen — so
  // the "live" pane polled once and then quietly stopped being live.
  page.addEventListener('mm:teardown', () => clearInterval(liveTimer));

  // ---- The tabbed lower half ---------------------------------------------
  function paintTabs() {
    render(tabHost, tabStrip({
      tabs: [
        { key: 'log', label: 'Call log', count: null },
        { key: 'voicemail', label: 'Voicemail', count: null },
        { key: 'ivr', label: 'IVR', count: null },
        { key: 'analytics', label: 'Analytics', count: null },
      ],
      active: activeTab,
      onChange: (key) => {
        activeTab = key;
        router.setQuery({ tab: key === 'log' ? null : key });
        paintTabs();
        paintTable();
      },
    }));
  }

  function paintTable() {
    if (activeTab === 'log') render(tableHost, card({ body: callLog().node, flush: true }));
    else if (activeTab === 'voicemail') render(tableHost, voicemailPane());
    else if (activeTab === 'ivr') render(tableHost, ivrPane(settings));
    else render(tableHost, analyticsPane());
  }

  paintTabs();
  paintTable();

  return page;
}

function providerName(settings) {
  return settings.providerCatalogue.find(p => p.key === settings.settings.provider)?.name
    ?? fmt.vendor(settings.settings.provider);
}

// ---------------------------------------------------------------------------
// Dial pad
// ---------------------------------------------------------------------------

/**
 * The dial pad.
 *
 * A real keypad rather than a bare text field: people dial numbers by pressing
 * digits, and on a phone a numeric keypad is what the thumb expects. The call
 * is placed by the provider — this never touches the audio.
 */
function dialPad(settings, connected) {
  const display = el('input.mm-dialpad__display', {
    type: 'tel',
    inputmode: 'tel',
    placeholder: '+91 98450 12233',
    'aria-label': 'Number to dial',
  });

  const press = (digit) => {
    display.value += digit;
    display.focus();
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

  const clientSelect = el('select.mm-select', { 'aria-label': 'Client this call is about' },
    el('option', { value: '', text: 'Not about a client' }));

  // Loaded in the background; the pad is usable before it arrives.
  api.get('/clients', { pageSize: 200 })
    .then(({ data }) => {
      for (const client of data ?? []) {
        clientSelect.append(el('option', {
          value: client.id,
          text: client.displayName,
          'data-phone': client.contactPhone ?? '',
        }));
      }
    })
    .catch(() => { /* the pad still dials a typed number */ });

  clientSelect.addEventListener('change', () => {
    const phone = clientSelect.selectedOptions[0]?.dataset.phone;
    if (phone && !display.value) display.value = phone;
  });

  const callButton = button('Call', { variant: 'primary', icon: 'phone' });
  callButton.classList.add('mm-btn--block');
  callButton.disabled = !connected;
  callButton.title = connected ? 'Place the call' : 'No telephony provider is connected';

  callButton.addEventListener('click', async () => {
    const to = display.value.trim();
    if (!to) { display.focus(); return; }

    callButton.disabled = true;
    callButton.textContent = 'Connecting…';
    try {
      const { data } = await api.post('/calls/dial', {
        to,
        clientId: clientSelect.value || undefined,
      });
      notify.success('Your phone should ring first, then the other party’s.', {
        title: 'Call placed',
        action: data?.call?.id ? { label: 'Open it', onClick: () => router.go(`/calls/${data.call.id}`) } : null,
      });
      display.value = '';
    } catch (err) {
      notifyError(err);
    } finally {
      callButton.disabled = !connected;
      callButton.textContent = 'Call';
    }
  });

  return card({
    title: 'Dial pad',
    subtitle: settings.settings.callerId
      ? `Calls show as ${settings.settings.callerId}`
      : 'No caller ID is set',
    body: frag(
      el('div.mm-dialpad',
        el('div.mm-dialpad__row',
          display,
          iconButton('x', {
            label: 'Clear',
            onClick: () => { display.value = display.value.slice(0, -1); display.focus(); },
          })),
        el('div.mm-dialpad__keys',
          ...keys.map(key => el('button.mm-dialpad__key', {
            type: 'button',
            text: key,
            onClick: () => press(key),
          })))),
      el('div.mm-field.mm-mt-3',
        el('label.mm-field__label', { text: 'About' }),
        clientSelect),
      callButton),
  });
}

function presenceControl() {
  const select = el('select.mm-select', { 'aria-label': 'Your availability' },
    ...['available', 'busy', 'away', 'dnd', 'offline'].map(p => el('option', {
      value: p, text: fmt.label(p === 'dnd' ? 'Do not disturb' : p),
    })));

  select.addEventListener('change', async () => {
    try {
      await api.post('/calls/presence', { presence: select.value });
      notify.success(`You are ${fmt.label(select.value === 'dnd' ? 'do not disturb' : select.value).toLowerCase()}.`, { timeout: 2000 });
    } catch (err) {
      notifyError(err);
    }
  });

  return select;
}

// ---------------------------------------------------------------------------
// Live calls
// ---------------------------------------------------------------------------
function liveCard(calls, reload) {
  return card({
    title: `${fmt.plural(calls.length, 'call')} in progress`,
    className: 'mm-card--live',
    flush: true,
    body: el('ul.mm-list',
      ...calls.map(call => el('li.mm-list__row.mm-list__row--live',
        el('span.mm-livedot', { 'aria-hidden': 'true' }),
        el('div.mm-list__main',
          el('a.mm-fw-medium', {
            href: `/calls/${call.id}`,
            text: call.clientName ?? call.toNumber ?? call.fromNumber,
          }),
          el('span.mm-muted.mm-text-xs', {
            text: [
              fmt.label(call.direction),
              call.agentName,
              call.startedAt ? `${fmt.duration((Date.now() - new Date(call.startedAt)) / 1000)} so far` : null,
            ].filter(Boolean).join(' · '),
          })),
        statusPill(call.status),
        el('div.mm-row.mm-gap-1',
          iconButton(call.isMuted ? 'mic-off' : 'mic', {
            label: call.isMuted ? 'Unmute' : 'Mute',
            onClick: () => control(call, call.isMuted ? 'unmute' : 'mute', reload),
          }),
          iconButton(call.isOnHold ? 'play' : 'pause', {
            label: call.isOnHold ? 'Resume' : 'Hold',
            onClick: () => control(call, call.isOnHold ? 'resume' : 'hold', reload),
          }),
          iconButton('x-circle', {
            label: 'Hang up',
            variant: 'danger',
            onClick: () => control(call, 'hangup', reload),
          }))))),
  });
}

async function control(call, action, reload) {
  try {
    await api.post(`/calls/${call.id}/control`, { action });
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------
function callLog() {
  return dataTable({
    searchPlaceholder: 'Search by number, client or agent…',
    defaultSort: 'started_at',
    onRowClick: (row) => router.go(`/calls/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'Direction',
        options: [
          { value: 'inbound', label: 'Inbound' },
          { value: 'outbound', label: 'Outbound' },
        ],
        value: active.direction ?? '',
        onChange: v => apply('direction', v),
      }),
      selectFilter({
        label: 'Outcome',
        options: [
          { value: 'completed', label: 'Completed' },
          { value: 'missed', label: 'Missed' },
          { value: 'failed', label: 'Failed' },
          { value: 'voicemail', label: 'Voicemail' },
        ],
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
    ],
    load: async (params) => {
      const { data, meta } = await api.get('/calls', params);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'direction',
        label: 'Call',
        primary: true,
        render: row => el('div.mm-row.mm-gap-3',
          el('span.mm-list__icon', { class: row.answered ? 'mm-c-success' : 'mm-c-danger' },
            icon(row.direction === 'inbound' ? 'phone-incoming' : 'phone', { size: 'sm' })),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: row.clientName ?? row.toNumber ?? row.fromNumber }),
            el('span.mm-muted.mm-text-xs', {
              text: [row.agentName, row.dispositionLabel].filter(Boolean).join(' · '),
            }))),
      },
      {
        key: 'durationSeconds',
        label: 'Duration',
        align: 'right',
        render: row => el('span.mm-numeric', { text: row.durationLabel ?? fmt.duration(row.durationSeconds) }),
      },
      {
        key: 'sentiment',
        label: 'Sentiment',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.sentiment
          ? pill(row.sentiment, row.sentiment === 'positive' ? 'success' : row.sentiment === 'negative' ? 'danger' : 'neutral')
          : null),
      },
      {
        key: 'recordingStatus',
        label: '',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.recordingStatus === 'available'
          ? icon('play', { size: 'sm', className: 'mm-muted', title: 'Recording available' })
          : null),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
      { key: 'startedAt', label: 'When', format: 'relative' },
    ],
    empty: {
      title: 'No calls yet',
      message: 'Calls placed from the dial pad, and calls that come in, both appear here.',
      icon: 'phone',
    },
  });
}

function voicemailPane() {
  const host = el('div');
  render(host, card({ body: el('div.mm-skeleton.mm-skeleton--line') }));

  api.get('/calls/voicemails')
    .then(({ data }) => {
      render(host, card({
        title: 'Voicemail',
        flush: true,
        body: (data ?? []).length
          ? el('ul.mm-list',
              ...data.map(voicemail => el('li.mm-list__row',
                el('span.mm-list__icon', { class: voicemail.status === 'new' ? 'mm-c-brand' : 'mm-muted' },
                  icon('mic', { size: 'sm' })),
                el('div.mm-list__main',
                  el('span.mm-fw-medium', { text: voicemail.fromNumber ?? voicemail.clientName ?? 'Unknown caller' }),
                  el('span.mm-muted.mm-text-xs', {
                    text: [fmt.duration(voicemail.durationSeconds), fmt.relative(voicemail.createdAt)]
                      .filter(Boolean).join(' · '),
                  }),
                  voicemail.transcript
                    ? el('span.mm-text-sm.mm-mt-1', { text: voicemail.transcript })
                    : null),
                statusPill(voicemail.status),
                el('select.mm-select.mm-select--sm', {
                  'aria-label': 'Voicemail status',
                  onChange: async (e) => {
                    try {
                      await api.post(`/calls/voicemails/${voicemail.id}/status`, { status: e.target.value });
                      notify.success('Updated.', { timeout: 1500 });
                    } catch (err) {
                      notifyError(err);
                    }
                  },
                },
                  ...['new', 'heard', 'actioned', 'archived'].map(s => el('option', {
                    value: s, selected: s === voicemail.status, text: fmt.label(s),
                  }))))))
          : emptyState({
              title: 'No voicemail',
              message: 'Messages left when nobody answers appear here, transcribed if transcription is on.',
              icon: 'mic',
              inline: true,
            }),
      }));
    })
    .catch(err => render(host, errorState(err)));

  return host;
}

function ivrPane(settings) {
  const flows = settings.ivrFlows ?? [];

  return card({
    title: 'IVR menus',
    subtitle: settings.settings.ivrEnabled
      ? 'What a caller hears before they reach anybody.'
      : 'IVR is switched off, so callers ring straight through.',
    flush: true,
    body: flows.length
      ? el('ul.mm-list',
          ...flows.map(flow => el('li.mm-list__row',
            el('span.mm-list__icon.mm-muted', icon('network', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: flow.name }),
              el('span.mm-muted.mm-text-xs', {
                text: `${fmt.plural((flow.nodes ?? flow.options ?? []).length, 'option')} · ${flow.greeting ? 'custom greeting' : 'default greeting'}`,
              })),
            statusPill(flow.is_active ? 'active' : 'inactive'))))
      : emptyState({
          title: 'No IVR menu configured',
          message: 'An IVR routes callers by what they press — "1 for filings, 2 for accounts".',
          icon: 'network',
          inline: true,
        }),
  });
}

function analyticsPane() {
  const host = el('div');
  render(host, card({ body: el('div.mm-skeleton.mm-skeleton--chart') }));

  Promise.all([
    api.get('/calls/analytics/overview'),
    api.get('/calls/analytics/performance').catch(() => ({ data: null })),
  ])
    .then(async ([{ data: overview }, { data: performance }]) => {
      const { barChart, donutChart, legend, rankBars } = await import('../../components/charts.js');
      const outcomes = (overview.outcomes ?? []).map(o => ({ label: o.label, value: o.count }));

      render(host,
        el('div.mm-grid.mm-grid-4.mm-gap-4',
          stat({ label: 'Calls', value: fmt.number(overview.totalCalls), icon: 'phone' }),
          stat({
            label: 'Answered',
            value: fmt.percent(overview.answerRatePct),
            caption: `${fmt.number(overview.answeredCalls)} of ${fmt.number(overview.totalCalls)}`,
            icon: 'check-circle',
            tone: overview.answerRatePct >= 80 ? 'success' : null,
          }),
          stat({ label: 'Average length', value: overview.avgDurationLabel ?? fmt.duration(overview.avgDurationSeconds), icon: 'clock' }),
          stat({
            label: 'Missed',
            value: fmt.number(overview.missedCalls),
            icon: 'phone-incoming',
            tone: overview.missedCalls > 0 ? 'warning' : null,
          })),

        el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
          card({
            title: 'Calls per day',
            subtitle: `${fmt.date(overview.period.from)} – ${fmt.date(overview.period.to)}`,
            body: barChart({
              series: (overview.callsPerDay ?? []).map(d => ({ label: d.day.slice(5), value: d.calls })),
              emptyMessage: 'No calls in this period.',
            }),
          }),
          card({
            title: 'Outcomes',
            body: el('div.mm-row.mm-gap-5.mm-wrap',
              donutChart({ series: outcomes, size: 176, emptyMessage: 'No dispositions recorded.' }),
              legend(outcomes)),
          })),

        performance?.agents?.length
          ? card({
              title: 'By agent',
              className: 'mm-mt-4',
              body: rankBars({
                rows: performance.agents.map(agent => ({
                  label: agent.name,
                  value: agent.calls ?? 0,
                  valueLabel: `${agent.calls} calls · ${agent.avgDurationLabel ?? fmt.duration(agent.avgDurationSeconds ?? 0)} average`,
                })),
                emptyMessage: 'Nobody has made a call in this period.',
              }),
            })
          : null);
    })
    .catch(err => render(host, errorState(err)));

  return host;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Telephony settings.
 *
 * The provider list shows which ones this deployment could use and exactly
 * which environment variables each is missing — a "not connected" with no
 * explanation is what generates support tickets.
 */
async function openSettings(settings) {
  const saved = await modal({
    title: 'Telephony settings',
    description: 'Which provider places your calls, and what happens to them afterwards.',
    size: 'lg',
    body: ({ close }) => {
      const provider = el('select.mm-select',
        ...settings.providerCatalogue.map(p => el('option', {
          value: p.key,
          selected: p.key === settings.settings.provider,
          text: `${p.name}${p.recommended ? ' — recommended for India' : ''}`,
        })));

      const callerId = el('input.mm-input', {
        value: settings.settings.callerId ?? '',
        placeholder: '+91 44 4000 1234',
      });

      const recordingMode = el('select.mm-select',
        ...['automatic', 'manual', 'off'].map(m => el('option', {
          value: m, selected: m === settings.settings.recordingMode, text: fmt.label(m),
        })));

      const retention = el('input.mm-input', {
        type: 'number', min: '1', max: '3650',
        value: String(settings.settings.recordingRetentionDays ?? 90),
      });

      const toggles = {
        transcriptionEnabled: toggle('Transcribe recordings', settings.settings.transcriptionEnabled),
        aiSummaryEnabled: toggle('Summarise calls', settings.settings.aiSummaryEnabled),
        sentimentEnabled: toggle('Detect sentiment', settings.settings.sentimentEnabled),
        autoCreateTask: toggle('Create a task for every missed call', settings.settings.autoCreateTask),
        autoLogActivity: toggle('Log calls on the client’s timeline', settings.settings.autoLogActivity),
        ivrEnabled: toggle('Answer with an IVR menu', settings.settings.ivrEnabled),
        voicemailEnabled: toggle('Take voicemail when nobody answers', settings.settings.voicemailEnabled),
      };

      const testButton = el('button.mm-btn.mm-btn--ghost', {
        type: 'button', text: 'Test the connection',
        onClick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Testing…';
          try {
            const { data } = await api.post('/calls/settings/test', {});
            if (data.ok) notify.success(data.message ?? 'The provider answered.');
            else notify.warning(data.message ?? 'The provider did not answer.', { title: 'Not connected' });
          } catch (err) {
            notifyError(err);
          } finally {
            e.target.disabled = false;
            e.target.textContent = 'Test the connection';
          }
        },
      });

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            provider: provider.value,
            callerId: callerId.value.trim() || undefined,
            recordingMode: recordingMode.value,
            recordingRetentionDays: Number(retention.value) || undefined,
            ...Object.fromEntries(Object.entries(toggles).map(([key, node]) => [key, node.input.checked])),
          });
        },
      },
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Provider' }), provider),
          el('div.mm-field', el('label.mm-field__label', { text: 'Caller ID' }), callerId)),

        providerStatusList(settings),

        el('div.mm-grid.mm-grid-2.mm-gap-3.mm-mt-4',
          el('div.mm-field', el('label.mm-field__label', { text: 'Recording' }), recordingMode),
          el('div.mm-field',
            el('label.mm-field__label', { text: 'Keep recordings for (days)' }), retention,
            el('p.mm-field__hint', { text: 'Recordings are deleted automatically once this passes.' }))),

        el('div.mm-stack.mm-gap-2.mm-mt-4', ...Object.values(toggles).map(t => t.node)),

        el('div.mm-row.mm-gap-2.mm-mt-5',
          testButton,
          el('span.mm-grow'),
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!saved) return;

  try {
    await api.patch('/calls/settings', saved);
    notify.success('Saved.');
    window.location.reload();
  } catch (err) {
    notifyError(err);
  }
}

function providerStatusList(settings) {
  return el('div.mm-mt-3',
    el('h3.mm-label', { text: 'What each provider needs' }),
    el('ul.mm-list.mm-list--tight',
      ...settings.providers.map(p => el('li.mm-list__row',
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: p.name }),
          el('span.mm-muted.mm-text-xs.mm-mono', {
            text: p.missingKeys?.length
              ? `Missing: ${p.missingKeys.join(', ')}`
              : `All keys set (${p.requiredKeys.join(', ')})`,
          })),
        p.configured ? pill('Ready', 'success') : pill('Needs keys', 'warning')))));
}

function toggle(label, checked) {
  const input = el('input.mm-checkbox', { type: 'checkbox', checked: !!checked });
  const node = el('label.mm-switch', input, el('span.mm-switch__text', el('span', { text: label })));
  return { input, node };
}

function capabilitiesCard(settings) {
  const caps = settings.capabilities ?? {};
  const entries = Object.entries(caps);
  if (!entries.length) return null;

  return card({
    title: 'What this provider supports',
    flush: true,
    body: el('ul.mm-checklist',
      ...entries.map(([key, supported]) => el('li.mm-checklist__item',
        el('span.mm-checklist__icon', { class: supported ? 'mm-c-success' : 'mm-muted' },
          icon(supported ? 'check' : 'x', { size: 'sm' })),
        el('span', { text: fmt.label(key) })))),
  });
}

function featuresCard(settings) {
  const groups = settings.featureGroups ?? [];
  if (!groups.length) return null;

  return card({
    title: 'Included in cloud calling',
    body: el('div.mm-stack.mm-gap-3',
      ...groups.map(group => el('div',
        el('h3.mm-label', { text: group.group }),
        el('ul.mm-ticklist',
          ...group.features.map(feature => el('li',
            icon('check', { size: 'sm' }),
            el('span', { text: feature }))))))),
  });
}
