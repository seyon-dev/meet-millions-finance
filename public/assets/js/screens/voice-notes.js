/**
 * Voice notes.
 *
 * Recording happens in the browser, with MediaRecorder — no plugin, no upload
 * dialog, no file to find afterwards. The screen is built around the two
 * things somebody actually does with a note: play it back, and read what was
 * said without playing it back.
 *
 * Where speech-to-text has no credentials on this deployment the recording
 * still saves and still plays; the transcript column says "Not configured"
 * rather than a spinner that never resolves.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as session from '../core/session.js';
import {
  pageHead, card, button, iconButton, pill, notify, notifyError, confirm, banner, emptyState,
} from '../core/ui.js';
import { dataTable, selectFilter } from '../components/table.js';
import { setBreadcrumbs } from '../layout/shell.js';

const TRANSCRIPT_TONE = {
  done: 'success',
  processing: 'info',
  pending: 'info',
  failed: 'danger',
  not_configured: 'warning',
  skipped: 'neutral',
};

const TRANSCRIPT_LABEL = {
  done: 'Transcribed',
  processing: 'Transcribing',
  pending: 'Queued',
  failed: 'Failed',
  not_configured: 'Not configured',
  skipped: 'No transcript',
};

export default async function voiceNotesScreen({ query }) {
  setBreadcrumbs([{ label: 'Communication' }, { label: 'Voice Notes' }]);

  const page = el('div.mm-page');
  const recorderHost = el('div');
  const noticeHost = el('div');

  const clients = await api.get('/clients', { pageSize: 200, sort: 'display_name', dir: 'asc' })
    .then(r => r.data ?? [])
    .catch(() => []);

  const table = dataTable({
    searchPlaceholder: 'Search what was said…',
    defaultSort: 'created_at',
    initialFilters: query.get('clientId') ? { clientId: query.get('clientId') } : null,
    filters: (apply, active) => [
      selectFilter({
        label: 'Client',
        options: clients.map(c => ({ value: c.id, label: c.displayName })),
        value: active.clientId ?? '',
        allLabel: 'Every client',
        onChange: v => apply('clientId', v),
      }),
      selectFilter({
        label: 'About',
        options: ['client', 'document', 'query', 'task'].map(k => ({ value: k, label: fmt.label(k) })),
        value: active.entityType ?? '',
        allLabel: 'Anything',
        onChange: v => apply('entityType', v),
      }),
    ],
    load: async (params) => {
      const { data, meta } = await api.get('/voice-notes', params);
      paintNotice(data ?? []);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'audio',
        label: 'Recording',
        primary: true,
        render: row => playerCell(row),
      },
      {
        key: 'clientName',
        label: 'About',
        render: row => el('div.mm-stack',
          row.clientId
            ? el('a.mm-text-sm', { href: `/clients/${row.clientId}`, text: row.clientName ?? 'Client' })
            : el('span.mm-muted.mm-text-sm', { text: '—' }),
          row.path && row.entityType !== 'client'
            ? el('a.mm-muted.mm-text-xs', { href: row.path, text: fmt.label(row.entityType) })
            : null),
      },
      {
        key: 'transcript',
        label: 'What was said',
        render: row => transcriptCell(row, table),
      },
      { key: 'authorName', label: 'Recorded by', hideOnMobile: true },
      { key: 'createdAt', label: 'When', format: 'relative' },
      {
        key: 'actions',
        label: '',
        align: 'right',
        render: row => (canDelete(row)
          ? iconButton('trash', {
              label: 'Delete this note',
              onClick: () => remove(row, table),
            })
          : null),
      },
    ],
    empty: {
      title: 'No voice notes yet',
      message: 'Record one from here, or from a client record while you are on a call.',
      icon: 'mic',
    },
  });

  /**
   * Say it once, at the top, when nothing can be transcribed on this
   * deployment — rather than repeating "Not configured" down a whole column
   * with no explanation of what would change it.
   */
  function paintNotice(rows) {
    const blocked = rows.some(r => r.transcriptStatus === 'not_configured');
    render(noticeHost, blocked
      ? banner({
          text: 'Speech-to-text has no credentials on this deployment, so recordings are saved and playable but not transcribed.',
          tone: 'warning',
          icon: 'mic-off',
          action: session.can('integrations.manage')
            ? { label: 'Open integrations', href: '/settings/integrations' }
            : null,
        })
      : frag());
  }

  render(recorderHost, recorderCard(clients, table));

  page.append(
    pageHead({
      title: 'Voice Notes',
      subtitle: 'Record what was said while it is still fresh; read it back as text.',
    }),
    noticeHost,
    recorderHost,
    card({ body: table.node, flush: true }));

  return page;
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

function recorderCard(clients, table) {
  const supported = typeof MediaRecorder !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia;

  if (!supported) {
    // Saying which browser feature is missing is more use than "unsupported".
    return card({
      title: 'Record a note',
      body: emptyState({
        title: 'This browser cannot record audio',
        message: 'MediaRecorder and microphone access are not available here. Recording works in a recent Chrome, Edge, Firefox or Safari over HTTPS.',
        icon: 'mic-off',
        inline: true,
      }),
    });
  }

  const clientSelect = el('select.mm-input.mm-select', { id: 'mm-vn-client' },
    el('option', { value: '', text: 'Choose a client…' }),
    ...clients.map(c => el('option', { value: c.id, text: c.displayName })));

  const timer = el('span.mm-voicerec__timer', { text: '0:00' });
  const level = el('span.mm-voicerec__level');
  const statusText = el('span.mm-muted.mm-text-sm', { text: 'Ready.' });
  const preview = el('div.mm-voicerec__preview');

  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let tick = null;
  let recorded = null;   // { blob, seconds }

  const recordBtn = button('Record', {
    variant: 'primary', icon: 'mic', onClick: () => (recorder ? stop() : start()),
  });
  const saveBtn = button('Save note', {
    variant: 'primary', icon: 'check', onClick: () => save(), disabled: true,
  });
  const discardBtn = button('Discard', {
    variant: 'ghost', icon: 'x', onClick: () => discard(), disabled: true,
  });

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Denied permission is a decision, not a fault — and the user has to be
      // told where to undo it, because the browser will not ask twice.
      notifyError(err?.name === 'NotAllowedError'
        ? new Error('Microphone access was blocked. Allow it for this site in your browser settings, then try again.')
        : err);
      return;
    }

    chunks = [];
    recorded = null;
    render(preview, frag());
    saveBtn.disabled = true;
    discardBtn.disabled = true;

    recorder = new MediaRecorder(stream, pickMime());
    recorder.addEventListener('dataavailable', e => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', finish);
    recorder.start();

    startedAt = Date.now();
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      // Ten minutes is long past the point of a "note".
      if (s >= 600) stop();
    }, 250);

    level.classList.add('is-live');
    recordBtn.textContent = 'Stop';
    statusText.textContent = 'Recording…';
  }

  function stop() {
    if (!recorder) return;
    recorder.stop();
    stream?.getTracks().forEach(t => t.stop());
    clearInterval(tick);
    level.classList.remove('is-live');
    recordBtn.textContent = 'Record';
  }

  function finish() {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    recorder = null;
    stream = null;
    recorded = { blob, seconds };

    render(preview,
      el('audio.mm-voicenote__player', { controls: true, src: URL.createObjectURL(blob) }),
      el('span.mm-muted.mm-text-xs', {
        text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · ${fmt.bytes(blob.size)}`,
      }));

    saveBtn.disabled = false;
    discardBtn.disabled = false;
    statusText.textContent = 'Listen back, then save it against a client.';
  }

  function discard() {
    recorded = null;
    chunks = [];
    render(preview, frag());
    saveBtn.disabled = true;
    discardBtn.disabled = true;
    timer.textContent = '0:00';
    statusText.textContent = 'Ready.';
  }

  async function save() {
    if (!recorded) return;
    const clientId = clientSelect.value;
    if (!clientId) {
      notify.warning('Choose which client this note is about.');
      clientSelect.focus();
      return;
    }

    const form = new FormData();
    const ext = (recorded.blob.type.includes('ogg') ? 'ogg' : recorded.blob.type.includes('mp4') ? 'm4a' : 'webm');
    form.append('audio', recorded.blob, `voice-note.${ext}`);
    form.append('clientId', clientId);
    form.append('durationSeconds', String(recorded.seconds));

    saveBtn.disabled = true;
    statusText.textContent = 'Saving…';

    try {
      const { data } = await api.upload('/voice-notes', form, {
        onProgress: (ratio) => { statusText.textContent = `Saving… ${Math.round(ratio * 100)}%`; },
      });

      const t = data?.transcription;
      if (t?.attempted && t.configured === false) {
        notify.warning('Note saved. It is not transcribed: speech-to-text has no credentials on this deployment.');
      } else if (t?.attempted && t.error) {
        notify.warning(`Note saved. The transcript failed: ${t.error}`);
      } else {
        notify.success('Voice note saved.');
      }

      discard();
      table.refresh();
    } catch (err) {
      notifyError(err);
      saveBtn.disabled = false;
      statusText.textContent = 'Not saved.';
    }
  }

  return card({
    title: 'Record a note',
    subtitle: 'Held on the client record, and transcribed where speech-to-text is configured.',
    body: el('div.mm-voicerec',
      el('div.mm-voicerec__controls',
        level,
        timer,
        recordBtn,
        saveBtn,
        discardBtn),
      el('div.mm-voicerec__meta',
        el('label.mm-field',
          el('span.mm-field__label', { text: 'Client' }),
          clientSelect),
        statusText),
      preview),
  });
}

/** Browsers disagree on what they can record; take the first they admit to. */
function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const found = candidates.find(type => MediaRecorder.isTypeSupported?.(type));
  return found ? { mimeType: found } : {};
}

// ---------------------------------------------------------------------------

/**
 * A recording, played on demand.
 *
 * R2 is private and the audio endpoint checks the session, but a bare
 * `<audio src="/api/…">` is a media request: the browser sends no
 * Authorization header on it, so the player would silently 401. The bytes are
 * therefore fetched through the API client and handed to the player as a blob
 * — and only when somebody asks, rather than pulling every recording on the
 * page into memory to show a duration nobody is listening to.
 */
function playerCell(row) {
  const host = el('div.mm-voicenote');
  const meta = el('span.mm-muted.mm-text-xs', {
    text: [row.durationLabel, row.sizeLabel].filter(Boolean).join(' · '),
  });

  const play = button('Play', {
    variant: 'ghost', icon: 'play', size: 'sm',
    onClick: async () => {
      play.disabled = true;
      play.replaceChildren(el('span.mm-spinner'), el('span', { text: 'Loading…' }));
      try {
        const response = await api.raw(`/voice-notes/${row.id}/audio`);
        const url = URL.createObjectURL(await response.blob());
        const audio = el('audio.mm-voicenote__player', { controls: true, src: url, autoplay: true });
        play.replaceWith(audio);
      } catch (err) {
        notifyError(err);
        play.disabled = false;
        play.replaceChildren(icon('play', { size: 'sm' }), el('span', { text: 'Play' }));
      }
    },
  });

  host.append(play, meta);
  return host;
}

function transcriptCell(row, table) {
  if (row.transcriptStatus === 'done' && row.transcript) {
    return el('div.mm-stack',
      el('p.mm-text-sm.mm-clamp-2', { text: row.transcript }),
      row.transcriptConfidence
        ? el('span.mm-muted.mm-text-xs', {
            text: `${Math.round(row.transcriptConfidence * 100)}% confidence${row.transcriptLang ? ` · ${row.transcriptLang}` : ''}`,
          })
        : null);
  }

  const status = row.transcriptStatus ?? 'pending';
  return el('div.mm-row.mm-gap-2.mm-wrap',
    pill(TRANSCRIPT_LABEL[status] ?? fmt.label(status), TRANSCRIPT_TONE[status] ?? 'neutral'),
    ['failed', 'not_configured', 'pending'].includes(status) && session.can('voicenotes.create')
      ? button('Try again', {
          variant: 'ghost', size: 'sm',
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              const { data } = await api.post(`/voice-notes/${row.id}/transcribe`);
              if (data?.configured === false) {
                notify.warning('Speech-to-text has no credentials on this deployment.');
              } else if (data?.error) {
                notify.warning(`The transcript failed: ${data.error}`);
              } else {
                notify.success('Transcribed.');
              }
              table.refresh();
            } catch (err) {
              notifyError(err);
              btn.disabled = false;
            }
          },
        })
      : null);
}

function canDelete(row) {
  return row.authorId === session.session().user?.id || session.can('clients.assign');
}

async function remove(row, table) {
  const yes = await confirm({
    title: 'Delete this voice note?',
    message: 'The recording and its transcript are removed. This cannot be undone.',
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!yes) return;

  try {
    await api.delete(`/voice-notes/${row.id}`);
    notify.success('Voice note deleted.');
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
