/**
 * The client upload screen.
 *
 * Built around the two ways people actually send documents: a pile dropped in
 * at once, or one file chosen at a time on a phone. Every file is listed with
 * its own real progress and its own outcome, because a single bar across a
 * batch hides the one file that failed.
 *
 * A ZIP is accepted and unpacked by the server; that is said on the screen
 * rather than discovered.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import {
  pageHead, card, button, notify, notifyError, errorState, emptyState, banner, statusPill,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function clientUploadScreen({ query }) {
  setBreadcrumbs([{ label: 'Your filings', href: '/client/dashboard' }, { label: 'Upload' }]);

  const page = el('div.mm-page');

  let context;
  try {
    context = await loadContext();
  } catch (err) {
    render(page, errorState(err, { onRetry: () => router.go(window.location.pathname) }));
    return page;
  }

  if (!context.clients.length) {
    render(page,
      pageHead({ title: 'Upload documents' }),
      emptyState({
        title: 'No company is linked to your account',
        message: 'Your accountant links your login to your company record. Ask them to do that and this screen will open.',
        icon: 'building',
      }));
    return page;
  }

  // ---- The queue ----------------------------------------------------------
  /** @type {{file: File, id: string, progress: number, state: string, message: string|null}[]} */
  let queue = [];
  let uploading = false;
  const queueHost = el('div.mm-uploadqueue');

  const clientSelect = el('select.mm-select',
    ...context.clients.map(client => el('option', {
      value: client.id,
      text: client.displayName,
      selected: client.id === query.get('clientId'),
    })));

  const typeSelect = el('select.mm-select',
    el('option', { value: '', text: 'Let my accountant decide' }),
    ...context.types.map(type => el('option', {
      value: type.id,
      text: type.name,
      selected: type.id === query.get('typeId'),
    })));

  const noteInput = el('textarea.mm-input.mm-textarea', {
    rows: '2',
    placeholder: 'Anything your accountant should know about these files (optional)',
  });

  const fileInput = el('input', {
    type: 'file',
    multiple: true,
    class: 'mm-sr-only',
    accept: context.accept,
    onChange: (e) => { add([...e.target.files]); e.target.value = ''; },
  });

  const dropZone = el('div.mm-dropzone', {
    tabindex: '0',
    role: 'button',
    'aria-label': 'Choose files to upload',
    onClick: () => fileInput.click(),
    onKeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    },
    onDragover: (e) => { e.preventDefault(); dropZone.classList.add('is-over'); },
    onDragleave: () => dropZone.classList.remove('is-over'),
    onDrop: (e) => {
      e.preventDefault();
      dropZone.classList.remove('is-over');
      add([...(e.dataTransfer?.files ?? [])]);
    },
  },
    el('span.mm-dropzone__icon', icon('upload', { size: 'xl' })),
    el('p.mm-dropzone__title', { text: 'Drop files here, or choose them' }),
    el('p.mm-dropzone__hint', {
      text: `${context.extensions} · up to ${fmt.bytes(context.maxBytes)} each · a ZIP is unpacked for you`,
    }),
    fileInput);

  const submit = button('Upload', { variant: 'primary', icon: 'upload', onClick: send });
  submit.disabled = true;

  function add(files) {
    const accepted = [];
    for (const file of files) {
      if (file.size > context.maxBytes) {
        notify.error(`${file.name} is ${fmt.bytes(file.size)}. The limit is ${fmt.bytes(context.maxBytes)}.`);
        continue;
      }
      if (queue.some(q => q.file.name === file.name && q.file.size === file.size)) continue;
      accepted.push({
        file,
        id: `${file.name}:${file.size}:${file.lastModified}`,
        progress: 0,
        state: 'queued',
        message: null,
      });
    }
    queue = [...queue, ...accepted];
    paintQueue();
  }

  function remove(id) {
    queue = queue.filter(item => item.id !== id);
    paintQueue();
  }

  function paintQueue() {
    submit.disabled = uploading || !queue.some(q => q.state === 'queued');
    submit.textContent = uploading
      ? 'Uploading…'
      : queue.length
        ? `Upload ${fmt.plural(queue.filter(q => q.state === 'queued').length, 'file')}`
        : 'Upload';

    if (!queue.length) {
      render(queueHost, el('p.mm-muted.mm-text-sm', { text: 'Nothing chosen yet.' }));
      return;
    }

    render(queueHost, el('ul.mm-list',
      ...queue.map(item => el('li.mm-list__row',
        el('span.mm-list__icon', { class: stateTone(item.state) },
          icon(stateIcon(item.state), { size: 'sm' })),
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: item.file.name }),
          el('span.mm-muted.mm-text-xs', {
            text: item.message ?? `${fmt.bytes(item.file.size)}${item.state === 'uploading' ? ` · ${Math.round(item.progress * 100)}%` : ''}`,
          }),
          item.state === 'uploading'
            ? el('span.mm-progress.mm-progress--sm.mm-mt-1',
                el('span.mm-progress__bar', { style: { width: `${Math.round(item.progress * 100)}%` } }))
            : null),
        item.state === 'queued'
          ? el('button.mm-iconbtn.mm-iconbtn--sm', {
              type: 'button', 'aria-label': `Remove ${item.file.name}`,
              onClick: () => remove(item.id),
            }, icon('x', { size: 'sm' }))
          : null))));
  }

  /**
   * Send the queue.
   *
   * One request per file rather than one request for all of them: a 30MB batch
   * that fails at the twenty-ninth megabyte would otherwise lose everything,
   * and per-file progress is only meaningful if the files are separate.
   */
  async function send() {
    if (uploading) return;
    const pending = queue.filter(q => q.state === 'queued');
    if (!pending.length) return;

    uploading = true;
    paintQueue();

    let succeeded = 0;
    for (const item of pending) {
      item.state = 'uploading';
      paintQueue();

      const form = new FormData();
      form.set('clientId', clientSelect.value);
      if (typeSelect.value) form.set('documentTypeId', typeSelect.value);
      if (noteInput.value.trim()) form.set('note', noteInput.value.trim());
      form.append('files', item.file, item.file.name);

      try {
        const { data } = await api.upload('/documents/upload', form, {
          onProgress: (fraction) => { item.progress = fraction; paintQueue(); },
        });

        const failure = data?.failed?.[0];
        if (failure) {
          item.state = 'failed';
          item.message = failure.reason;
        } else if (data?.batch) {
          item.state = 'done';
          item.message = `Unpacked — ${fmt.plural(data.created?.length ?? 0, 'document')} created`;
          succeeded += 1;
        } else {
          item.state = 'done';
          item.message = 'Sent to your accountant';
          succeeded += 1;
        }
      } catch (err) {
        item.state = 'failed';
        item.message = err.message;
        if (err.name === 'FeatureLocked' || err.status === 413) notifyError(err);
      }
      paintQueue();
    }

    uploading = false;
    paintQueue();

    if (succeeded) {
      notify.success(`${fmt.plural(succeeded, 'file')} uploaded.`, {
        action: { label: 'See your documents', onClick: () => router.go('/documents') },
      });
    }
    if (succeeded === pending.length) {
      // Clear only what actually landed; a failed file stays on screen so it
      // can be retried without being hunted for again.
      queue = queue.filter(q => q.state !== 'done');
      noteInput.value = '';
      paintQueue();
    }
  }

  page.append(
    pageHead({
      title: 'Upload documents',
      subtitle: 'Your accountant is told as soon as a file arrives.',
      actions: button('Back to your filings', { variant: 'ghost', href: '/client/dashboard' }),
    }),

    context.checklist.length
      ? banner({
          text: `Still needed this month: ${context.checklist.slice(0, 4).map(c => c.label).join(', ')}${context.checklist.length > 4 ? `, and ${context.checklist.length - 4} more` : ''}.`,
          tone: 'info',
          icon: 'list',
        })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      card({
        title: 'Choose your files',
        flush: false,
        body: frag(dropZone, el('div.mm-mt-4', queueHost)),
        footer: el('div.mm-row.mm-end.mm-gap-2',
          button('Clear', {
            variant: 'ghost',
            onClick: () => { queue = queue.filter(q => q.state === 'uploading'); paintQueue(); },
          }),
          submit),
      }),

      card({
        title: 'Where these belong',
        body: frag(
          field('Company', clientSelect,
            context.clients.length === 1 ? 'Your only linked company.' : null),
          field('Document type', typeSelect,
            'Leave this alone if you are not sure — your accountant will sort it.'),
          field('Note', noteInput, null)),
      })));

  paintQueue();
  return page;
}

async function loadContext() {
  const [clients, types, dashboard, settings] = await Promise.all([
    api.get('/clients', { pageSize: 50 }),
    api.get('/documents/types/list'),
    api.get('/dashboard').catch(() => ({ data: {} })),
    api.get('/settings').catch(() => ({ data: {} })),
  ]);

  const limits = settings.data?.uploadLimits ?? {};
  const extensions = limits.allowedExtensions?.length
    ? limits.allowedExtensions.slice(0, 6).map(e => e.toUpperCase()).join(', ')
    : 'PDF, JPG, PNG, XLSX';

  return {
    clients: clients.data ?? [],
    types: (types.data ?? []).filter(t => t.is_active !== 0),
    checklist: dashboard.data?.pendingChecklist ?? [],
    maxBytes: limits.maxBytes ?? 25 * 1024 * 1024,
    extensions,
    accept: limits.allowedExtensions?.length
      ? limits.allowedExtensions.map(e => `.${e}`).join(',')
      : undefined,
  };
}

function field(label, control, hint) {
  return el('div.mm-field',
    el('label.mm-field__label', { text: label }),
    control,
    hint ? el('p.mm-field__hint', { text: hint }) : null);
}

function stateIcon(state) {
  return { queued: 'file', uploading: 'upload', done: 'check-circle', failed: 'x-circle' }[state] ?? 'file';
}

function stateTone(state) {
  return { done: 'mm-c-success', failed: 'mm-c-danger', uploading: 'mm-c-brand' }[state] ?? 'mm-muted';
}
