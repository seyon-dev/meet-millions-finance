/**
 * Tasks.
 *
 * A board by default, because work in five states is easier to grasp as
 * columns than as a list — and a list underneath it, because a board is
 * useless once there are two hundred cards. Both read the same data.
 *
 * Dragging a card changes its status through the same API a dropdown would,
 * with the card returned to where it came from if the server refuses.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as router from '../core/router.js';
import * as session from '../core/session.js';
import {
  pageHead, card, button, statusPill, pill, avatar, emptyState, errorState, skeletonTable,
  notify, notifyError, modal, confirm,
} from '../core/ui.js';
import { setBreadcrumbs } from '../layout/shell.js';

const COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'review', label: 'In review' },
  { key: 'done', label: 'Done' },
];

export default async function tasksScreen({ query }) {
  setBreadcrumbs([{ label: 'Tasks' }]);

  const page = el('div.mm-page');
  const boardHost = el('div');

  let mineOnly = query.get('mine') !== 'all';
  let people = [];
  let clients = [];

  async function load() {
    render(boardHost, skeletonTable(5, 4));
    try {
      const { data, meta } = await api.get('/tasks', {
        mine: mineOnly ? 'true' : undefined,
        pageSize: 200,
      });
      render(boardHost, board(data ?? [], meta.board ?? [], load));
    } catch (err) {
      render(boardHost, errorState(err, { onRetry: load }));
    }
  }

  [people, clients] = await Promise.all([
    session.can('users.view')
      ? api.get('/users', { pageSize: 100 }).then(r => r.data ?? []).catch(() => [])
      : Promise.resolve([]),
    session.can('clients.view') || session.can('clients.view.assigned')
      ? api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => [])
      : Promise.resolve([]),
  ]);

  page.append(
    pageHead({
      title: 'Tasks',
      subtitle: 'Everything the practice owes somebody, by state.',
      actions: frag(
        button(mineOnly ? 'Show everyone’s' : 'Show only mine', {
          variant: 'ghost',
          icon: 'users',
          onClick: () => {
            mineOnly = !mineOnly;
            router.setQuery({ mine: mineOnly ? null : 'all' });
            router.go(window.location.pathname + window.location.search);
          },
        }),
        session.can('tasks.create')
          ? button('New task', {
              variant: 'primary', icon: 'plus',
              onClick: () => createTask(people, clients, load),
            })
          : null),
    }),
    boardHost);

  await load();
  return page;
}

function board(tasks, counts, reload) {
  const byStatus = new Map(COLUMNS.map(c => [c.key, []]));
  for (const task of tasks) {
    if (byStatus.has(task.status)) byStatus.get(task.status).push(task);
  }

  if (!tasks.length) {
    return emptyState({
      title: 'No tasks',
      message: 'Tasks are created here, and automatically from missed calls, overdue filings and rejected documents.',
      icon: 'list',
    });
  }

  const countFor = key => counts.find(c => c.key === key)?.count ?? byStatus.get(key).length;

  return el('div.mm-board',
    ...COLUMNS.map(column => el('section.mm-board__col', {
      'data-status': column.key,
      onDragover: (e) => {
        if (!session.can('tasks.update')) return;
        e.preventDefault();
        e.currentTarget.classList.add('is-over');
      },
      onDragleave: (e) => e.currentTarget.classList.remove('is-over'),
      onDrop: async (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('is-over');
        const id = e.dataTransfer?.getData('text/plain');
        if (!id) return;
        const task = tasks.find(t => t.id === id);
        if (!task || task.status === column.key) return;

        try {
          await api.patch(`/tasks/${id}`, { status: column.key });
          await reload();
        } catch (err) {
          notifyError(err);
          await reload();
        }
      },
    },
      el('header.mm-board__head',
        el('span.mm-board__title', { text: column.label }),
        el('span.mm-board__count', { text: String(countFor(column.key)) })),

      el('div.mm-board__cards',
        ...byStatus.get(column.key).map(task => taskCard(task, reload)),
        byStatus.get(column.key).length
          ? null
          : el('p.mm-board__empty', { text: 'Nothing here' })))));
}

function taskCard(task, reload) {
  const draggable = session.can('tasks.update');

  return el('article.mm-taskcard', {
    class: task.overdue ? 'is-overdue' : '',
    draggable,
    tabindex: '0',
    onDragstart: (e) => {
      e.dataTransfer.setData('text/plain', task.id);
      e.dataTransfer.effectAllowed = 'move';
      e.currentTarget.classList.add('is-dragging');
    },
    onDragend: (e) => e.currentTarget.classList.remove('is-dragging'),
    onClick: () => openTask(task, reload),
    onKeydown: (e) => { if (e.key === 'Enter') openTask(task, reload); },
  },
    el('div.mm-taskcard__head',
      el('span.mm-taskcard__title', { text: task.title }),
      task.priority && task.priority !== 'normal'
        ? pill(task.priority, task.priority === 'urgent' ? 'danger' : 'warning')
        : null),

    task.clientName
      ? el('a.mm-taskcard__client', { href: `/clients/${task.clientId}`, text: task.clientName })
      : null,

    el('div.mm-taskcard__foot',
      task.assigneeName
        ? el('span.mm-row.mm-gap-2.mm-center',
            avatar(task.assigneeName, { size: 'xs' }),
            el('span.mm-text-xs', { text: task.assigneeName.split(' ')[0] }))
        : el('span.mm-muted.mm-text-xs', { text: 'Unassigned' }),
      el('span.mm-grow'),
      task.dueAt
        ? el('span.mm-text-xs', {
            class: task.overdue ? 'mm-c-danger' : 'mm-muted',
            title: fmt.dateTime(task.dueAt),
            text: task.overdue ? 'Overdue' : (fmt.untilDays(task.dueAt)?.label ?? fmt.date(task.dueAt)),
          })
        : null),

    task.type && task.type !== 'general'
      ? el('span.mm-taskcard__type', { text: fmt.label(task.type) })
      : null);
}

/** A task, opened for editing. */
async function openTask(task, reload) {
  const result = await modal({
    title: task.title,
    description: [task.clientName, fmt.label(task.type)].filter(Boolean).join(' · ') || null,
    body: ({ close }) => {
      const status = el('select.mm-select',
        ...[...COLUMNS.map(c => c.key), 'cancelled'].map(key => el('option', {
          value: key, selected: key === task.status, text: fmt.label(key),
        })));
      const priority = el('select.mm-select',
        ...['low', 'normal', 'high', 'urgent'].map(p => el('option', {
          value: p, selected: p === task.priority, text: fmt.label(p),
        })));
      const due = el('input.mm-input', {
        type: 'date',
        value: task.dueAt ? String(task.dueAt).slice(0, 10) : '',
      });

      return frag(
        task.description ? el('p.mm-prose', { text: task.description }) : null,
        el('div.mm-kvgrid.mm-mb-4',
          el('div.mm-kv',
            el('span.mm-kv__k', { text: 'Assigned to' }),
            el('span.mm-kv__v', { text: task.assigneeName ?? 'Nobody' })),
          el('div.mm-kv',
            el('span.mm-kv__k', { text: 'Created' }),
            el('span.mm-kv__v', { text: fmt.dateTime(task.createdAt) }))),

        session.can('tasks.update')
          ? frag(
              el('div.mm-grid.mm-grid-3.mm-gap-3',
                el('div.mm-field', el('label.mm-field__label', { text: 'Status' }), status),
                el('div.mm-field', el('label.mm-field__label', { text: 'Priority' }), priority),
                el('div.mm-field', el('label.mm-field__label', { text: 'Due' }), due)),
              el('div.mm-row.mm-gap-2.mm-mt-4',
                session.can('tasks.delete')
                  ? el('button.mm-btn.mm-btn--ghost.mm-btn--danger-text', {
                      type: 'button', text: 'Delete', onClick: () => close({ action: 'delete' }),
                    })
                  : null,
                el('span.mm-grow'),
                el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) }),
                el('button.mm-btn.mm-btn--primary', {
                  type: 'button',
                  text: 'Save',
                  onClick: () => close({
                    action: 'save',
                    status: status.value,
                    priority: priority.value,
                    dueAt: due.value || null,
                  }),
                })))
          : el('div.mm-row.mm-end.mm-mt-4',
              el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) })));
    },
  });

  if (!result) return;

  if (result.action === 'delete') {
    const answer = await confirm({
      title: 'Delete this task?',
      message: 'It disappears from the board for everyone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!answer) return;
    try {
      await api.delete(`/tasks/${task.id}`);
      notify.success('Deleted.');
      await reload();
    } catch (err) {
      notifyError(err);
    }
    return;
  }

  try {
    await api.patch(`/tasks/${task.id}`, {
      status: result.status,
      priority: result.priority,
      dueAt: result.dueAt || undefined,
    });
    notify.success('Saved.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function createTask(people, clients, reload) {
  const payload = await modal({
    title: 'New task',
    body: ({ close }) => {
      const title = el('input.mm-input', { placeholder: 'Chase the missing bank statement', required: true });
      const description = el('textarea.mm-input.mm-textarea', { rows: '3', placeholder: 'Any detail worth recording' });
      const assignee = el('select.mm-select',
        el('option', { value: '', text: 'Nobody yet' }),
        ...people.map(p => el('option', { value: p.id, text: p.fullName })));
      const client = el('select.mm-select',
        el('option', { value: '', text: 'No client' }),
        ...clients.map(c => el('option', { value: c.id, text: c.displayName })));
      const type = el('select.mm-select',
        ...['general', 'verification', 'follow_up', 'collection', 'filing', 'reconciliation', 'onboarding', 'support']
          .map(t => el('option', { value: t, text: fmt.label(t) })));
      const priority = el('select.mm-select',
        ...['low', 'normal', 'high', 'urgent'].map(p => el('option', {
          value: p, selected: p === 'normal', text: fmt.label(p),
        })));
      const due = el('input.mm-input', { type: 'date' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!title.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Give the task a title.' }));
            return;
          }
          close({
            title: title.value.trim(),
            description: description.value.trim() || undefined,
            assignedTo: assignee.value || undefined,
            clientId: client.value || undefined,
            type: type.value,
            priority: priority.value,
            dueAt: due.value || undefined,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Title' }), title),
        el('div.mm-field', el('label.mm-field__label', { text: 'Detail' }), description),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Assign to' }), assignee),
          el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), client)),
        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Type' }), type),
          el('div.mm-field', el('label.mm-field__label', { text: 'Priority' }), priority),
          el('div.mm-field', el('label.mm-field__label', { text: 'Due' }), due)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Create' })));
    },
  });
  if (!payload) return;

  try {
    await api.post('/tasks', payload);
    notify.success('Task created.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
