/**
 * The notification centre.
 *
 * A drawer rather than a dropdown: these carry a title, a body and a link, and
 * a 320px menu would truncate all three. Opening it marks nothing read —
 * reading is an action the person takes.
 */

import { el, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as router from '../core/router.js';
import { drawer, emptyState, errorState, notifyError, button } from '../core/ui.js';
import * as fmt from '../core/format.js';

const SEVERITY_ICON = {
  info: 'info', success: 'check-circle', warning: 'alert', danger: 'x-circle',
};

export async function openNotifications({ onRead = null } = {}) {
  await drawer({
    title: 'Notifications',
    subtitle: 'Everything that needs your attention',
    body: ({ close }) => {
      const list = el('div.mm-notifs__list');
      const head = el('div.mm-notifs__head');
      let closeDrawer = close;

      async function load() {
        render(list, el('div.mm-skeleton.mm-skeleton--text'),
          el('div.mm-skeleton.mm-skeleton--text'),
          el('div.mm-skeleton.mm-skeleton--text'));

        try {
          const { data, meta } = await api.get('/notifications', { pageSize: 30 });
          paintHead(meta?.unread ?? 0);

          if (!data?.length) {
            render(list, emptyState({
              title: 'Nothing waiting',
              message: 'Notifications about your documents, approvals and deadlines appear here.',
              icon: 'bell',
              inline: true,
            }));
            return;
          }

          render(list, ...data.map(item => el('article.mm-notif', {
            class: item.read ? 'is-read' : '',
          },
            el('span.mm-notif__icon', {
              class: `mm-notif__icon--${item.severity ?? 'info'}`,
            }, icon(item.icon ?? SEVERITY_ICON[item.severity] ?? 'info', { size: 'sm' })),

            el('div.mm-notif__main',
              el('p.mm-notif__title', { text: item.title }),
              item.body ? el('p.mm-notif__body', { text: item.body }) : null,
              el('div.mm-row.mm-gap-2.mm-mt-1',
                el('span.mm-notif__time', {
                  title: fmt.dateTime(item.createdAt),
                  text: fmt.relative(item.createdAt),
                }),
                item.linkPath
                  ? el('button.mm-btn.mm-btn--xs.mm-btn--ghost', {
                      type: 'button',
                      text: 'Open',
                      onClick: async () => {
                        await markRead([item.id]);
                        closeDrawer(null);
                        router.go(item.linkPath);
                      },
                    })
                  : null,
                !item.read
                  ? el('button.mm-btn.mm-btn--xs.mm-btn--ghost', {
                      type: 'button',
                      text: 'Mark read',
                      onClick: async () => { await markRead([item.id]); load(); },
                    })
                  : null)),

            el('button.mm-iconbtn.mm-iconbtn--sm', {
              type: 'button',
              'aria-label': 'Dismiss',
              onClick: async () => {
                try {
                  await api.delete(`/notifications/${item.id}`);
                  load();
                } catch (err) { notifyError(err); }
              },
            }, icon('x', { size: 'sm' })))));
        } catch (err) {
          render(list, errorState(err, { onRetry: load }));
        }
      }

      function paintHead(unread) {
        render(head,
          el('span.mm-muted.mm-text-sm', {
            text: unread ? `${fmt.number(unread)} unread` : 'All caught up',
          }),
          el('span.mm-grow'),
          unread
            ? button('Mark all read', {
                variant: 'ghost', size: 'sm',
                onClick: async () => { await markRead(null); load(); },
              })
            : null,
          button('Settings', {
            variant: 'ghost', size: 'sm', icon: 'settings',
            onClick: () => { closeDrawer(null); router.go('/settings/notifications'); },
          }));
      }

      async function markRead(ids) {
        try {
          await api.post('/notifications/read', ids ? { ids } : { all: true });
          onRead?.();
        } catch (err) {
          notifyError(err);
        }
      }

      load();
      return el('div.mm-notifs', head, list);
    },
  });
}
