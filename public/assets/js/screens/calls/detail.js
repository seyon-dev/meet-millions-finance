/**
 * One call.
 *
 * What was said, what was decided, and what happens next. The recording, the
 * transcript and any machine summary are all here, each labelled with where it
 * came from — a summary a person did not write should never be mistaken for
 * notes a person did write.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, iconButton, statusPill, pill, avatar,
  emptyState, errorState, skeletonTable, notify, notifyError, modal, banner,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function callDetailScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(6, 3));

  async function load() {
    try {
      const { data } = await api.get(`/calls/${params.id}`);
      setBreadcrumbs([
        { label: 'Calling', href: '/calls' },
        { label: data.client?.display_name ?? data.call.toNumber ?? 'Call' },
      ]);
      render(page, ...build(data, load));
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, reload) {
  const { call, client, agent, notes, disposition, tags, recording, transcript, ai, followUpTask, permissions } = data;

  return [
    pageHead({
      title: client?.display_name ?? call.toNumber ?? call.fromNumber ?? 'Call',
      subtitle: [
        fmt.label(call.direction),
        agent?.full_name,
        fmt.dateTime(call.startedAt),
        call.durationLabel ?? fmt.duration(call.durationSeconds),
      ].filter(Boolean).join(' · '),
      actions: frag(
        statusPill(call.status),
        client
          ? button('Open the client', { variant: 'ghost', icon: 'users', href: `/clients/${client.id}` })
          : null,
        session.hasFeature('cloud_telephony') && (call.toNumber || call.fromNumber)
          ? button('Call back', {
              variant: 'ghost', icon: 'phone',
              onClick: () => callBack(call),
            })
          : null,
        !call.dispositionKey && session.can('calls.notes')
          ? button('Record the outcome', {
              variant: 'primary', icon: 'check',
              onClick: () => setDisposition(call, reload),
            })
          : null),
    }),

    call.status === 'missed' && !call.missedHandled
      ? banner({
          text: 'This call was missed and nobody has followed it up.',
          tone: 'warning',
          icon: 'phone-incoming',
          action: session.can('calls.notes')
            ? { label: 'Mark it handled', onClick: () => handleMissed(call, reload) }
            : null,
        })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        recording ? recordingCard(call, recording, permissions) : null,
        transcript ? transcriptCard(transcript) : null,
        ai ? aiCard(ai) : null,
        notesCard(call, notes ?? [], permissions, reload)),

      el('div.mm-stack.mm-gap-4',
        detailsCard(call, agent, client),
        outcomeCard(call, disposition, tags ?? [], followUpTask, reload))),
  ].filter(Boolean);
}

/**
 * The recording.
 *
 * Played through an authorised blob rather than a bare <audio src>, which
 * would request the file without the session header. The waveform, when the
 * provider gives one, is drawn rather than faked.
 */
function recordingCard(call, recording, permissions) {
  const host = el('div');

  if (!permissions?.canListen) {
    render(host, emptyState({
      title: 'You cannot listen to this recording',
      message: 'Your role can see that a recording exists, but not play it.',
      icon: 'lock',
      inline: true,
    }));
  } else if (!recording.available) {
    render(host, emptyState({
      title: `The recording is ${fmt.label(recording.status).toLowerCase()}`,
      message: recording.status === 'processing'
        ? 'The provider is still preparing it. It usually takes a minute or two after the call ends.'
        : 'It is not available to play.',
      icon: 'mic',
      inline: true,
    }));
  } else {
    render(host, el('div.mm-preview__loading', el('span.mm-spinner'), el('span', { text: 'Loading the recording…' })));

    api.raw(`/calls/${call.id}/recording`)
      .then(response => response.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const audio = el('audio.mm-audio', { controls: true, src: url, preload: 'metadata' });

        render(host,
          audio,
          recording.waveform?.length
            ? el('div.mm-recorder__wave', { 'aria-hidden': 'true' },
                ...recording.waveform.map(level => el('span.mm-recorder__bar', {
                  style: { height: `${Math.max(8, Math.min(100, level * 100))}%` },
                })))
            : null,
          el('p.mm-muted.mm-text-xs.mm-mt-2', {
            text: [
              fmt.duration(recording.durationSeconds),
              fmt.bytes(recording.sizeBytes),
              recording.retentionUntil ? `kept until ${fmt.date(recording.retentionUntil)}` : null,
            ].filter(Boolean).join(' · '),
          }));
      })
      .catch(err => render(host, errorState(err)));
  }

  return card({
    title: 'Recording',
    actions: permissions?.canDownload && recording.available
      ? iconButton('download', {
          label: 'Download the recording',
          onClick: () => api.download(`/calls/${call.id}/recording`, { query: { download: 'true' } })
            .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
            .catch(notifyError),
        })
      : null,
    body: host,
  });
}

function transcriptCard(transcript) {
  return card({
    title: 'Transcript',
    subtitle: [
      fmt.label(transcript.status),
      transcript.language ? fmt.label(transcript.language) : null,
      transcript.confidence ? `${Math.round(transcript.confidence * 100)}% confidence` : null,
      transcript.wordCount ? `${fmt.number(transcript.wordCount)} words` : null,
    ].filter(Boolean).join(' · '),
    body: transcript.segments?.length
      ? el('ol.mm-transcript',
          ...transcript.segments.map(segment => el('li.mm-transcript__line',
            el('span.mm-transcript__time', { text: fmt.duration(segment.startSeconds ?? segment.start ?? 0) }),
            el('span.mm-transcript__speaker', { text: segment.speaker ?? 'Speaker' }),
            el('span.mm-transcript__text', { text: segment.text }))))
      : (transcript.text
          ? el('p.mm-prose', { text: transcript.text })
          : el('p.mm-muted.mm-text-sm', {
              text: transcript.error ?? `The transcript is ${fmt.label(transcript.status).toLowerCase()}.`,
            })),
  });
}

/** The machine's reading of the call, labelled as such. */
function aiCard(ai) {
  return card({
    title: 'Call summary',
    subtitle: ai.disclaimer,
    className: 'mm-card--ai',
    body: frag(
      el('div.mm-row.mm-gap-2.mm-center.mm-mb-3',
        icon('sparkle', { size: 'sm' }),
        ai.sentiment
          ? pill(ai.sentiment, ai.sentiment === 'positive' ? 'success' : ai.sentiment === 'negative' ? 'danger' : 'neutral')
          : null,
        ai.model ? el('span.mm-muted.mm-text-xs', { text: ai.model }) : null),

      ai.summary ? el('p.mm-prose', { text: ai.summary }) : null,

      ai.keyPoints?.length
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Key points' }),
            el('ul.mm-ticklist',
              ...ai.keyPoints.map(point => el('li', icon('check', { size: 'sm' }), el('span', { text: point })))))
        : null,

      ai.actionItems?.length
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Suggested actions' }),
            el('ul.mm-ticklist',
              ...ai.actionItems.map(item => el('li',
                icon('arrow-right', { size: 'sm' }),
                el('span', { text: typeof item === 'string' ? item : item.text })))))
        : null,

      ai.nextStep ? el('p.mm-prose.mm-mt-3', { text: `Next: ${ai.nextStep}` }) : null,
      ai.error ? el('p.mm-c-danger.mm-text-sm', { text: ai.error }) : null),
  });
}

function notesCard(call, notes, permissions, reload) {
  const input = el('textarea.mm-input.mm-textarea', {
    rows: '3', placeholder: 'What was agreed?', 'aria-label': 'Call note',
  });

  const form = permissions?.canNote
    ? el('form.mm-form.mm-mt-3', {
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          const body = input.value.trim();
          if (!body) return;
          const submitButton = form.querySelector('button[type=submit]');
          submitButton.disabled = true;
          try {
            await api.post(`/calls/${call.id}/notes`, { body, duringCall: call.isLive });
            input.value = '';
            await reload();
          } catch (err) {
            notifyError(err);
            submitButton.disabled = false;
          }
        },
      },
        input,
        el('div.mm-row.mm-end.mm-mt-2',
          el('button.mm-btn.mm-btn--primary.mm-btn--sm', { type: 'submit', text: 'Add note' })))
    : null;

  return card({
    title: 'Notes',
    body: frag(
      notes.length
        ? el('ol.mm-thread',
            ...notes.map(note => el('li.mm-thread__item',
              avatar(note.author_name, { size: 'sm' }),
              el('div.mm-thread__body',
                el('div.mm-thread__head',
                  el('span.mm-fw-medium', { text: note.author_name ?? 'Someone' }),
                  note.during_call ? pill('During the call', 'info') : null,
                  el('span.mm-muted.mm-text-xs', { text: fmt.relative(note.created_at) })),
                el('p.mm-thread__text', { text: note.body })))))
        : el('p.mm-muted.mm-text-sm', { text: 'No notes were taken on this call.' }),
      form),
  });
}

function detailsCard(call, agent, client) {
  return card({
    title: 'Details',
    body: el('div.mm-kvgrid',
      kv('Direction', fmt.label(call.direction)),
      kv('From', call.fromNumber, { mono: true }),
      kv('To', call.toNumber, { mono: true }),
      kv('Virtual number', call.virtualNumber, { mono: true }),
      kv('Agent', agent?.full_name),
      kv('Client', client?.display_name),
      kv('Provider', fmt.label(call.provider)),
      kv('Started', fmt.dateTime(call.startedAt)),
      kv('Answered', call.answeredAt ? fmt.dateTime(call.answeredAt) : 'Not answered'),
      kv('Ended', call.endedAt ? fmt.dateTime(call.endedAt) : null),
      kv('Duration', call.durationLabel ?? fmt.duration(call.durationSeconds)),
      kv('Talk time', call.talkSeconds ? fmt.duration(call.talkSeconds) : null),
      kv('Transferred to', call.transferredTo),
      kv('Conference', call.isConference ? 'Yes' : null)),
  });
}

function outcomeCard(call, disposition, tags, followUpTask, reload) {
  return card({
    title: 'Outcome',
    actions: session.can('calls.notes')
      ? button(call.dispositionKey ? 'Change' : 'Record', {
          variant: 'ghost', size: 'sm',
          onClick: () => setDisposition(call, reload),
        })
      : null,
    body: frag(
      disposition || call.dispositionLabel
        ? frag(
            el('div.mm-row.mm-gap-2.mm-center',
              pill(call.dispositionLabel ?? disposition?.label,
                call.dispositionOutcome === 'positive' ? 'success'
                  : call.dispositionOutcome === 'negative' ? 'danger' : 'neutral')),
            tags.length
              ? el('div.mm-row.mm-gap-1.mm-wrap.mm-mt-2', ...tags.map(tag => pill(tag, 'neutral')))
              : null)
        : el('p.mm-muted.mm-text-sm', { text: 'No outcome has been recorded for this call.' }),

      call.followUpAt
        ? el('p.mm-text-sm.mm-mt-3', { text: `Follow up ${fmt.dateTime(call.followUpAt)}.` })
        : null,

      followUpTask
        ? el('div.mm-mt-3',
            el('a.mm-link', { href: '/tasks', text: `Task: ${followUpTask.title}` }))
        : null),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function setDisposition(call, reload) {
  const settings = await api.get('/calls/settings').then(r => r.data).catch(() => null);
  const dispositions = settings?.dispositions ?? [];

  const payload = await modal({
    title: 'Record the outcome',
    description: 'What came of this call, and what happens next.',
    body: ({ close }) => {
      const disposition = el('select.mm-select',
        ...dispositions.map(d => el('option', {
          value: d.key, selected: d.key === call.dispositionKey, text: d.label,
        })));
      const note = el('textarea.mm-input.mm-textarea', { rows: '3', placeholder: 'Anything worth recording' });
      const followUp = el('input.mm-input', { type: 'datetime-local' });
      const createTask = el('input.mm-checkbox', { type: 'checkbox', checked: true });
      const errorHost = el('div');

      if (!dispositions.length) {
        return frag(
          el('p', { text: 'No call outcomes have been configured for this organisation yet.' }),
          el('div.mm-row.mm-end.mm-mt-4',
            el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) })));
      }

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!disposition.value) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Choose an outcome.' }));
            return;
          }
          close({
            dispositionKey: disposition.value,
            note: note.value.trim() || undefined,
            followUpAt: followUp.value ? new Date(followUp.value).toISOString() : undefined,
            createTask: createTask.checked,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Outcome' }), disposition),
        el('div.mm-field', el('label.mm-field__label', { text: 'Note' }), note),
        el('div.mm-field',
          el('label.mm-field__label', { text: 'Follow up at' }), followUp,
          el('p.mm-field__hint', { text: 'Leave blank if nothing needs chasing.' })),
        el('label.mm-switch',
          createTask,
          el('span.mm-switch__text', el('span', { text: 'Create a task for the follow-up' }))),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!payload) return;

  try {
    await api.post(`/calls/${call.id}/disposition`, payload);
    notify.success('Outcome recorded.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function handleMissed(call, reload) {
  try {
    await api.post(`/calls/${call.id}/missed/handle`, {});
    notify.success('Marked as handled.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function callBack(call) {
  const to = call.direction === 'inbound' ? call.fromNumber : call.toNumber;
  try {
    const { data } = await api.post('/calls/dial', { to, clientId: call.clientId ?? undefined });
    notify.success('Calling back…', {
      action: data?.call?.id
        ? { label: 'Open it', onClick: () => { window.location.href = `/calls/${data.call.id}`; } }
        : null,
    });
  } catch (err) {
    notifyError(err);
  }
}
