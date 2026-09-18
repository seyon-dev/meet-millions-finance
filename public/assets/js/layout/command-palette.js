/**
 * The command palette — Ctrl/Cmd-K.
 *
 * Searches clients, documents, reports, invoices, staff, queries and calls in
 * one query, and also offers the screens this particular person may open. The
 * server filters every source by the caller's permissions, so what appears
 * here is already what they are allowed to see.
 */

import { el, render, debounce, trapFocus } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as router from '../core/router.js';
import { notify } from '../core/ui.js';

let host = null;
let open = false;

export function openCommandPalette(initial = '') {
  if (open) return;
  open = true;

  if (!host) {
    host = el('div.mm-cmd-host');
    document.body.append(host);
  }

  let results = [];
  let cursor = 0;
  let token = 0;

  const input = el('input.mm-cmd__input', {
    type: 'search',
    placeholder: 'Search clients, documents, reports — or jump to a screen',
    'aria-label': 'Search',
    autocomplete: 'off',
    spellcheck: 'false',
    value: initial,
    onInput: debounce(e => search(e.target.value), 180),
    onKeydown: onKey,
  });

  const list = el('div.mm-cmd__results', { role: 'listbox' });

  const panel = el('div.mm-cmd', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
    el('div.mm-cmd__input-wrap',
      icon('search', { size: 'sm' }),
      input,
      el('button.mm-iconbtn.mm-iconbtn--sm', {
        type: 'button', 'aria-label': 'Close', onClick: close,
      }, icon('x', { size: 'sm' }))),
    list,
    el('div.mm-cmd__footer',
      el('span', el('kbd.mm-kbd', { text: '↑↓' }), ' to move'),
      el('span', el('kbd.mm-kbd', { text: '↵' }), ' to open'),
      el('span', el('kbd.mm-kbd', { text: 'esc' }), ' to close')));

  const wrap = el('div',
    el('div.mm-modal__backdrop', { onClick: close }),
    panel);

  const previouslyFocused = document.activeElement;
  render(host, wrap);
  document.body.classList.add('mm-scroll-lock');
  const releaseTrap = trapFocus(panel);
  input.focus();
  search(initial);

  function close() {
    open = false;
    releaseTrap();
    host.replaceChildren();
    document.body.classList.remove('mm-scroll-lock');
    previouslyFocused?.focus?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = results[cursor];
      if (chosen) { close(); router.go(chosen.path); }
    }
  }

  function move(delta) {
    if (!results.length) return;
    cursor = (cursor + delta + results.length) % results.length;
    paint();
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  async function search(term) {
    const ticket = ++token;
    try {
      const { data } = await api.get('/search', { q: term, limit: 6 });
      if (ticket !== token) return;

      results = [];
      const groups = [];

      if (!term || term.trim().length < 2) {
        const suggestions = data?.suggestions ?? [];
        if (suggestions.length) {
          groups.push({ group: 'Go to', items: suggestions.slice(0, 12) });
        }
      } else {
        groups.push(...(data?.groups ?? []));
      }

      for (const group of groups) {
        for (const item of group.items) results.push({ ...item, group: group.group });
      }
      cursor = 0;
      paint(groups, term);
    } catch (err) {
      if (ticket !== token) return;
      results = [];
      render(list, el('p.mm-cmd__note', { text: err.message ?? 'Search is unavailable right now.' }));
    }
  }

  function paint(groups = null, term = '') {
    if (!results.length) {
      render(list, el('p.mm-cmd__note', {
        text: term.trim().length >= 2
          ? `Nothing matches “${term}”.`
          : 'Type at least two characters to search.',
      }));
      return;
    }

    const nodes = [];
    let index = 0;
    for (const group of (groups ?? [{ group: '', items: results }])) {
      nodes.push(el('p.mm-cmd__group-label', { text: group.group }));
      for (const item of group.items) {
        const i = index++;
        nodes.push(el('button.mm-cmd__item', {
          type: 'button',
          role: 'option',
          class: i === cursor ? 'is-active' : '',
          'aria-selected': i === cursor ? 'true' : 'false',
          onMouseenter: () => { cursor = i; paint(groups, term); },
          onClick: () => {
            // A locked screen opens anyway — it explains what would unlock it,
            // which is more useful than refusing to navigate.
            close();
            router.go(item.path);
          },
        },
          icon(item.icon ?? iconForGroup(group.group), { size: 'sm' }),
          el('span.mm-cmd__item-main',
            el('span.mm-cmd__item-title', { text: item.title }),
            item.subtitle ? el('span.mm-cmd__item-sub', { text: item.subtitle }) : null),
          item.locked
            ? icon('lock', { size: 'sm', title: 'Not in your plan' })
            : (item.badge ? el('span.mm-pill.mm-pill--plain', { text: item.badge }) : null)));
      }
    }
    render(list, ...nodes);
  }
}

function iconForGroup(group) {
  return {
    'Go to': 'compass',
    Clients: 'users',
    Documents: 'file',
    Reports: 'report',
    Invoices: 'rupee',
    Team: 'team',
    Queries: 'message',
    Calls: 'phone',
  }[group] ?? 'search';
}
