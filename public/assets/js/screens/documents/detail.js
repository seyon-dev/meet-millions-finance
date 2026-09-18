/**
 * One document.
 *
 * The file on the left, everything known about it on the right. Version
 * history, the verification trail, the client conversation and any machine
 * reading of it are all here, because the question this screen answers is
 * "can I rely on this?" and that is a question about provenance.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, iconButton, statusPill, pill, avatar, emptyState, errorState,
  notify, notifyError, modal, banner, skeletonTable,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function documentDetailScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(6, 4));

  async function load() {
    try {
      const { data } = await api.get(`/documents/${params.id}`);
      setBreadcrumbs([
        { label: 'Documents', href: '/documents' },
        { label: data.document.title },
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
  const { document: doc, type, client, versions, comments, verifications, queries, ocr, aiCheck, permissions } = data;
  const current = versions?.find(v => v.is_current) ?? versions?.[0] ?? null;

  return [
    pageHead({
      title: doc.title,
      subtitle: [client?.display_name, type?.name, fmt.label(doc.periodKey)].filter(Boolean).join(' · '),
      actions: actions(doc, current, permissions, reload),
    }),

    doc.isLocked
      ? banner({
          text: 'This document is locked. Its file and status cannot be changed until it is unlocked.',
          tone: 'info',
          icon: 'lock',
        })
      : null,

    doc.status === 'rejected' && doc.rejectedReason
      ? banner({ text: `Rejected: ${doc.rejectedReason}`, tone: 'danger', icon: 'x-circle' })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        previewCard(doc, current, permissions),
        ocr ? ocrCard(ocr) : null,
        aiCheck ? aiCard(aiCheck) : null,
        commentsCard(doc, comments ?? [], permissions, reload)),

      el('div.mm-stack.mm-gap-4',
        factsCard(doc, type, client, current),
        versionsCard(versions ?? [], doc),
        verificationCard(verifications ?? []),
        queriesCard(queries ?? [], doc))),
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Header actions
// ---------------------------------------------------------------------------
function actions(doc, current, permissions, reload) {
  return frag(
    permissions?.canDownload && current
      ? button('Download', {
          variant: 'ghost', icon: 'download',
          onClick: () => api.download(`/documents/${doc.id}/download`, { fileName: current.file_name })
            .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
            .catch(notifyError),
        })
      : null,

    permissions?.canDownload && current
      ? button('Share link', { variant: 'ghost', icon: 'link', onClick: () => shareLink(doc) })
      : null,

    permissions?.canLock
      ? button(doc.isLocked ? 'Unlock' : 'Lock', {
          variant: 'ghost', icon: doc.isLocked ? 'key' : 'lock',
          onClick: () => toggleLock(doc, reload),
        })
      : null,

    permissions?.canReplace && !doc.isLocked
      ? button('Replace file', { variant: 'ghost', icon: 'upload', onClick: () => replaceFile(doc, reload) })
      : null,

    permissions?.canVerify && !doc.isLocked
      ? button('Open in verification', {
          variant: 'primary', icon: 'file-check',
          href: `/verification/${doc.id}`,
        })
      : null);
}

/**
 * A time-limited link to the file.
 *
 * The link carries its own signature rather than the session, so it can be
 * pasted into an email — and expires, so pasting it into an email is not a
 * permanent grant.
 */
async function shareLink(doc) {
  const minutes = await modal({
    title: 'Create a share link',
    description: 'Anyone with the link can open the file until it expires. No sign-in is needed.',
    size: 'sm',
    body: ({ close }) => {
      const select = el('select.mm-select',
        ...[15, 60, 240, 1440].map(m => el('option', {
          value: String(m),
          selected: m === 60,
          text: m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : m === 240 ? '4 hours' : '24 hours',
        })));

      return frag(
        el('div.mm-field',
          el('label.mm-field__label', { text: 'Expires after' }),
          select),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', {
            type: 'button', text: 'Create link', onClick: () => close(Number(select.value)),
          })));
    },
  });
  if (!minutes) return;

  try {
    const { data } = await api.post(`/documents/${doc.id}/share-link`, { expiresInMinutes: minutes });
    const url = new URL(data.url, window.location.origin).href;
    await navigator.clipboard?.writeText(url);
    notify.success(`Link copied. It opens ${data.fileName} and expires in ${minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`}.`);
  } catch (err) {
    notifyError(err);
  }
}

async function toggleLock(doc, reload) {
  try {
    await api.post(`/documents/${doc.id}/lock`, { locked: !doc.isLocked });
    notify.success(doc.isLocked ? 'Unlocked.' : 'Locked. The file and its status are now fixed.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

/**
 * Upload a corrected file as a new version.
 *
 * Never overwrites: the old version stays, numbered, so a reviewer can see
 * exactly what changed and when.
 */
async function replaceFile(doc, reload) {
  const result = await modal({
    title: 'Replace the file',
    description: 'The current file is kept as an earlier version. Nothing is overwritten.',
    body: ({ close }) => {
      const fileInput = el('input.mm-input', { type: 'file', required: true });
      const noteInput = el('textarea.mm-input.mm-textarea', {
        rows: '3', placeholder: 'What changed in this version?',
      });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const file = fileInput.files?.[0];
          if (!file) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Choose a file.' }));
            return;
          }
          close({ file, note: noteInput.value.trim() });
        },
      },
        el('div.mm-field',
          el('label.mm-field__label', { text: 'New file' }),
          fileInput,
          errorHost),
        el('div.mm-field',
          el('label.mm-field__label', { text: 'Note' }),
          noteInput),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Upload version' })));
    },
  });
  if (!result) return;

  const form = new FormData();
  form.append('file', result.file, result.file.name);
  if (result.note) form.set('note', result.note);

  try {
    const { data } = await api.upload(`/documents/${doc.id}/versions`, form);
    notify.success(`Version ${data.version?.version_no ?? ''} uploaded.`.replace('  ', ' '));
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * The file itself.
 *
 * PDFs and images are shown inline through an authorised blob URL — a plain
 * <embed src="/files/…"> would arrive without the session header and render a
 * 401 page inside the frame. Anything else offers a download, honestly
 * labelled, rather than an empty box.
 */
function previewCard(doc, version, permissions) {
  const host = el('div.mm-preview');

  if (!version) {
    render(host, emptyState({ title: 'No file on this document yet', icon: 'file', inline: true }));
  } else if (!permissions?.canDownload) {
    render(host, emptyState({
      title: 'You cannot open this file',
      message: 'Your role can see that the document exists, but not its contents.',
      icon: 'lock',
      inline: true,
    }));
  } else {
    render(host, el('div.mm-preview__loading', el('span.mm-spinner'), el('span', { text: 'Opening the file…' })));

    api.raw(`/documents/${doc.id}/download`)
      .then(response => response.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (version.mime_type?.startsWith('image/')) {
          render(host, el('img.mm-preview__img', { src: url, alt: version.file_name }));
        } else if (version.mime_type === 'application/pdf') {
          render(host, el('iframe.mm-preview__frame', {
            src: url, title: version.file_name, loading: 'lazy',
          }));
        } else {
          URL.revokeObjectURL(url);
          render(host, emptyState({
            title: `${version.file_name}`,
            message: `${fmt.label(version.mime_type ?? 'This file type')} cannot be shown in the browser. Download it to open it.`,
            icon: 'file',
            inline: true,
            action: {
              label: 'Download',
              onClick: () => api.download(`/documents/${doc.id}/download`, { fileName: version.file_name })
                .catch(notifyError),
            },
          }));
        }
      })
      .catch((err) => render(host, errorState(err)));
  }

  return card({
    title: version?.file_name ?? 'File',
    subtitle: version
      ? `Version ${version.version_no} · ${fmt.bytes(version.size_bytes)} · uploaded ${fmt.relative(version.created_at)}`
      : null,
    body: host,
    flush: true,
  });
}

function factsCard(doc, type, client, version) {
  return card({
    title: 'Details',
    actions: statusPill(doc.status),
    body: el('div.mm-kvgrid',
      kv('Client', client?.display_name),
      kv('Client code', client?.client_code, { mono: true }),
      kv('Type', type?.name),
      kv('Category', type?.category ? fmt.label(type.category) : null),
      kv('Period', fmt.label(doc.periodKey)),
      kv('Priority', fmt.label(doc.priority)),
      kv('Source', fmt.label(doc.source)),
      kv('Uploaded', fmt.dateTime(doc.createdAt)),
      kv('Submitted', doc.submittedAt ? fmt.dateTime(doc.submittedAt) : null),
      kv('Verified', doc.verifiedAt ? fmt.dateTime(doc.verifiedAt) : null),
      kv('SLA due', doc.slaDueAt ? fmt.dateTime(doc.slaDueAt) : null),
      kv('Checksum', version?.checksum_sha256 ? `${version.checksum_sha256.slice(0, 16)}…` : null, { mono: true })),
  });
}

function versionsCard(versions, doc) {
  return card({
    title: 'Versions',
    subtitle: versions.length > 1 ? `${versions.length} uploaded` : null,
    flush: true,
    body: versions.length
      ? el('ul.mm-list',
          ...versions.map(version => el('li.mm-list__row',
            el('span.mm-list__icon', { class: version.is_current ? 'mm-c-brand' : 'mm-muted' },
              icon('file', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: `v${version.version_no} — ${version.file_name}` }),
              el('span.mm-muted.mm-text-xs', {
                text: [
                  version.uploaded_by_name,
                  fmt.bytes(version.size_bytes),
                  fmt.relative(version.created_at),
                ].filter(Boolean).join(' · '),
              }),
              version.upload_note
                ? el('span.mm-text-xs.mm-mt-1', { text: version.upload_note })
                : null),
            version.is_current ? pill('Current', 'success') : null,
            iconButton('download', {
              label: `Download version ${version.version_no}`,
              onClick: () => api.download(`/documents/${doc.id}/download`, {
                fileName: version.file_name,
                query: { versionId: version.id },
              }).catch(notifyError),
            }))))
      : emptyState({ title: 'No versions', icon: 'file', inline: true }),
  });
}

function verificationCard(records) {
  return card({
    title: 'Verification trail',
    flush: true,
    body: records.length
      ? el('ol.mm-timeline',
          ...records.map(record => el('li.mm-timeline__item',
            el('span.mm-timeline__dot', {
              class: `mm-timeline__dot--${record.decision === 'approved' ? 'success' : record.decision === 'rejected' ? 'danger' : 'warning'}`,
            }),
            el('div.mm-timeline__content',
              el('p.mm-timeline__title', {
                text: `${fmt.label(record.decision)} by ${record.verifier_name ?? 'a colleague'}`,
              }),
              record.notes ? el('p.mm-text-sm', { text: record.notes }) : null,
              el('p.mm-timeline__meta', {
                text: [
                  fmt.dateTime(record.created_at),
                  record.sla_met === 1 ? 'within SLA' : record.sla_met === 0 ? 'past SLA' : null,
                  record.time_spent_seconds ? fmt.duration(record.time_spent_seconds) : null,
                ].filter(Boolean).join(' · '),
              })))))
      : emptyState({
          title: 'Not reviewed yet',
          message: 'Every decision on this document will be recorded here, with who made it and when.',
          icon: 'file-check',
          inline: true,
        }),
  });
}

function queriesCard(queries, doc) {
  return card({
    title: 'Questions raised',
    actions: session.can('queries.create')
      ? button('Ask the client', { variant: 'ghost', size: 'sm', icon: 'message-circle', href: `/verification/${doc.id}` })
      : null,
    flush: true,
    body: queries.length
      ? el('ul.mm-list',
          ...queries.map(query => el('li.mm-list__row',
            el('a.mm-list__main', { href: `/queries/${query.id}` },
              el('span.mm-fw-medium', { text: query.subject }),
              el('span.mm-muted.mm-text-xs', {
                text: [query.reference_no, fmt.relative(query.created_at)].filter(Boolean).join(' · '),
              })),
            statusPill(query.status))))
      : emptyState({ title: 'Nothing has been queried', icon: 'message-circle', inline: true }),
  });
}

/**
 * The conversation on the document.
 *
 * Internal notes and shared comments live in one thread with a visibility
 * marker, rather than in two places — a reviewer reading the history needs to
 * see both in order, and the server already refuses to send internal notes to
 * a client.
 */
function commentsCard(doc, comments, permissions, reload) {
  const listHost = el('div');

  const paint = () => render(listHost, comments.length
    ? el('ol.mm-thread',
        ...comments.map(comment => el('li.mm-thread__item',
          { class: comment.visibility === 'internal' ? 'is-internal' : '' },
          avatar(comment.author_name, { size: 'sm' }),
          el('div.mm-thread__body',
            el('div.mm-thread__head',
              el('span.mm-fw-medium', { text: comment.author_name ?? 'Client' }),
              comment.visibility === 'internal' ? pill('Internal note', 'warning') : null,
              el('span.mm-muted.mm-text-xs', {
                title: fmt.dateTime(comment.created_at),
                text: fmt.relative(comment.created_at),
              })),
            el('p.mm-thread__text', { text: comment.body })))))
    : emptyState({ title: 'No comments yet', icon: 'message', inline: true }));

  paint();

  const input = el('textarea.mm-input.mm-textarea', {
    rows: '3',
    placeholder: 'Add a comment…',
    'aria-label': 'Comment',
  });

  const visibility = el('select.mm-select',
    el('option', { value: 'shared', text: 'Visible to the client' }),
    permissions?.canAddInternalNote
      ? el('option', { value: 'internal', text: 'Internal note' })
      : null);

  const form = permissions?.canComment
    ? el('form.mm-form.mm-mt-3', {
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          const body = input.value.trim();
          if (!body) return;

          const submitButton = form.querySelector('button[type=submit]');
          submitButton.disabled = true;
          try {
            await api.post(`/documents/${doc.id}/comments`, { body, visibility: visibility.value });
            input.value = '';
            notify.success('Comment added.');
            await reload();
          } catch (err) {
            notifyError(err);
            submitButton.disabled = false;
          }
        },
      },
        input,
        el('div.mm-row.mm-gap-2.mm-mt-2',
          visibility,
          el('span.mm-grow'),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Comment' })))
    : null;

  return card({
    title: 'Conversation',
    body: frag(listHost, form),
  });
}

/** What OCR read from the file, with its confidence stated rather than implied. */
function ocrCard(ocr) {
  const fields = ocr.fields ?? [];
  return card({
    title: 'Machine reading',
    subtitle: `${ocr.provider ?? 'OCR'} · ${fmt.label(ocr.status)}${ocr.confidence ? ` · ${Math.round(ocr.confidence * 100)}% confidence` : ''}`,
    body: fields.length
      ? el('div.mm-kvgrid',
          ...fields.map(field => kv(
            fmt.label(field.key ?? field.label),
            field.value ?? '—',
            { mono: /amount|gstin|pan|invoice/i.test(field.key ?? '') })))
      : el('p.mm-muted.mm-text-sm', {
          text: ocr.status === 'failed'
            ? (ocr.error ?? 'The file could not be read.')
            : 'Nothing was extracted from this file.',
        }),
  });
}

/** The automated pre-check. Advisory, and labelled as such. */
function aiCard(check) {
  const checks = check.checks ?? [];
  const flags = check.flags ?? [];

  return card({
    title: 'Automated checks',
    subtitle: 'Advisory only — a person still decides.',
    className: 'mm-card--ai',
    body: frag(
      el('div.mm-row.mm-gap-2.mm-center.mm-mb-3',
        icon('sparkle', { size: 'sm' }),
        pill(check.verdict ?? check.status, check.verdict === 'pass' ? 'success' : check.verdict === 'fail' ? 'danger' : 'warning'),
        check.confidence
          ? el('span.mm-muted.mm-text-xs', { text: `${Math.round(check.confidence * 100)}% confidence` })
          : null),
      checks.length
        ? el('ul.mm-checklist',
            ...checks.map(item => el('li.mm-checklist__item',
              el('span.mm-checklist__icon', { class: item.passed ? 'mm-c-success' : 'mm-c-warning' },
                icon(item.passed ? 'check' : 'alert', { size: 'sm' })),
              el('span', { text: item.label ?? item.key }),
              item.detail ? el('span.mm-muted.mm-text-xs', { text: item.detail }) : null)))
        : null,
      flags.length
        ? el('ul.mm-flags.mm-mt-3',
            ...flags.map(flag => el('li.mm-flags__item',
              icon('alert', { size: 'sm' }),
              el('span', { text: flag.message ?? String(flag) }))))
        : null),
  });
}
