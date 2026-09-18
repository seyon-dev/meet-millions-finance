/**
 * The data table.
 *
 * One component behind every list screen, so sorting, paging, selection,
 * loading and empty states behave identically everywhere. Below the mobile
 * breakpoint each row re-renders as a stacked card rather than becoming a
 * horizontally scrolling table nobody can read on a phone.
 */

import { el, frag, on, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { emptyState, errorState, skeletonTable, button } from '../core/ui.js';
import * as fmt from '../core/format.js';

/**
 * @param {object} options
 * @param {{key,label,render?,sortable?,align?,width?,primary?,hideOnMobile?}[]} options.columns
 * @param {(params) => Promise<{rows,meta}>} options.load
 */
export function dataTable({
  columns,
  load,
  rowKey = (row) => row.id,
  onRowClick = null,
  selectable = false,
  bulkActions = null,
  toolbar = null,
  search = true,
  searchPlaceholder = 'Search…',
  filters = null,
  defaultSort = null,
  defaultDir = 'desc',
  pageSize = 25,
  empty = { title: 'Nothing here yet', message: null, icon: 'inbox', action: null },
  onLoaded = null,
  compact = false,
}) {
  const state = {
    page: 1,
    pageSize,
    sort: defaultSort,
    dir: defaultDir,
    q: '',
    filters: {},
    rows: [],
    meta: {},
    selected: new Set(),
    loading: true,
    error: null,
  };

  const host = el('div.mm-table-host');
  const bodyHost = el('div');
  const bulkBar = el('div.mm-table-bulkbar', { hidden: true });
  let requestToken = 0;

  const toolbarNode = buildToolbar();
  host.append(toolbarNode, bulkBar, bodyHost);

  function buildToolbar() {
    if (!search && !filters && !toolbar) return frag();

    const searchInput = search
      ? el('div.mm-input-group.mm-table-toolbar__search',
          el('span.mm-input-group__icon', icon('search', { size: 'sm' })),
          el('input.mm-input', {
            type: 'search',
            placeholder: searchPlaceholder,
            'aria-label': searchPlaceholder,
            onInput: debounce((e) => {
              state.q = e.target.value.trim();
              state.page = 1;
              refresh();
            }, 300),
          }))
      : null;

    return el('div.mm-table-toolbar',
      searchInput,
      filters ? el('div.mm-row.mm-gap-2.mm-wrap', filters(applyFilter, state.filters)) : null,
      el('span.mm-grow'),
      toolbar ? el('div.mm-row.mm-gap-2', toolbar({ refresh })) : null);
  }

  function applyFilter(key, value) {
    if (value === null || value === undefined || value === '') delete state.filters[key];
    else state.filters[key] = value;
    state.page = 1;
    refresh();
  }

  async function refresh() {
    const ticket = ++requestToken;
    state.loading = true;
    state.error = null;
    paint();

    try {
      const result = await load({
        page: state.page,
        pageSize: state.pageSize,
        sort: state.sort,
        dir: state.dir,
        q: state.q || undefined,
        ...state.filters,
      });
      // A slower earlier request must not overwrite a newer one's results.
      if (ticket !== requestToken) return;
      state.rows = result?.rows ?? result?.data ?? [];
      state.meta = result?.meta ?? {};
      state.loading = false;
      onLoaded?.(state);
    } catch (err) {
      if (ticket !== requestToken) return;
      state.loading = false;
      state.error = err;
    }
    paint();
  }

  function paint() {
    if (state.loading && !state.rows.length) {
      bodyHost.replaceChildren(skeletonTable(6, Math.min(columns.length, 6)));
      return;
    }
    if (state.error) {
      bodyHost.replaceChildren(errorState(state.error, { onRetry: refresh }));
      return;
    }
    if (!state.rows.length) {
      bodyHost.replaceChildren(emptyState({
        ...empty,
        title: state.q ? `Nothing matches “${state.q}”` : empty.title,
        message: state.q ? 'Try a different search, or clear it to see everything.' : empty.message,
      }));
      return;
    }

    bodyHost.replaceChildren(
      el('div.mm-table-wrap', { class: state.loading ? 'is-refreshing' : '' },
        buildTable(),
        buildCards()),
      buildPagination());
  }

  function buildTable() {
    const table = el('table.mm-table', { class: compact ? 'mm-table--compact' : '' },
      el('thead',
        el('tr',
          selectable
            ? el('th.mm-table__check',
                el('input.mm-checkbox', {
                  type: 'checkbox',
                  'aria-label': 'Select all rows on this page',
                  checked: state.rows.length > 0 && state.rows.every(r => state.selected.has(rowKey(r))),
                  onChange: (e) => {
                    for (const row of state.rows) {
                      if (e.target.checked) state.selected.add(rowKey(row));
                      else state.selected.delete(rowKey(row));
                    }
                    paint();
                    paintBulkBar();
                  },
                }))
            : null,
          ...columns.map(column => el('th', {
            class: [
              column.align ? `mm-align-${column.align}` : '',
              column.hideOnMobile ? 'mm-hide-sm' : '',
            ].filter(Boolean).join(' '),
            style: column.width ? { width: column.width } : null,
            'aria-sort': state.sort === column.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : null,
          },
            column.sortable
              ? el('button.mm-table__sort', {
                  type: 'button',
                  onClick: () => {
                    if (state.sort === column.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
                    else { state.sort = column.key; state.dir = 'desc'; }
                    refresh();
                  },
                },
                  el('span', { text: column.label }),
                  state.sort === column.key
                    ? icon(state.dir === 'asc' ? 'chevron-up' : 'chevron-down', { size: 'sm', className: 'mm-table__sort-icon' })
                    : null)
              : el('span', { text: column.label }))))));

    const tbody = el('tbody');
    for (const row of state.rows) {
      const key = rowKey(row);
      tbody.append(el('tr', {
        class: onRowClick ? 'mm-table__row--clickable' : '',
        tabindex: onRowClick ? '0' : null,
        onClick: onRowClick ? (e) => {
          if (e.target.closest('button, a, input, label')) return;
          onRowClick(row);
        } : null,
        onKeydown: onRowClick ? (e) => {
          if (e.key === 'Enter') { e.preventDefault(); onRowClick(row); }
        } : null,
      },
        selectable
          ? el('td.mm-table__check',
              el('input.mm-checkbox', {
                type: 'checkbox',
                'aria-label': 'Select row',
                checked: state.selected.has(key),
                onChange: (e) => {
                  if (e.target.checked) state.selected.add(key);
                  else state.selected.delete(key);
                  paintBulkBar();
                },
              }))
          : null,
        ...columns.map(column => el('td', {
          class: [
            column.align ? `mm-align-${column.align}` : '',
            column.hideOnMobile ? 'mm-hide-sm' : '',
          ].filter(Boolean).join(' '),
        }, cellContent(column, row)))));
    }
    table.append(tbody);
    return table;
  }

  /**
   * The same rows as stacked cards, shown instead of the table on a phone.
   *
   * Not a shrunken table: the primary column becomes a title and the rest
   * become labelled pairs, because a table squeezed into 375px is unreadable
   * however carefully its columns are sized.
   */
  function buildCards() {
    const list = el('div.mm-card-list');
    for (const row of state.rows) {
      const primary = columns.find(c => c.primary) ?? columns[0];
      const rest = columns.filter(c => c !== primary && !c.hideOnCard);

      list.append(el('article.mm-record', {
        tabindex: onRowClick ? '0' : null,
        onClick: onRowClick ? (e) => {
          if (e.target.closest('button, a, input, label')) return;
          onRowClick(row);
        } : null,
        onKeydown: onRowClick ? (e) => {
          if (e.key === 'Enter') { e.preventDefault(); onRowClick(row); }
        } : null,
      },
        el('div.mm-record__head',
          el('div.mm-record__title', cellContent(primary, row))),
        el('div.mm-record__grid',
          ...rest.map(column => el('div.mm-record__cell',
            el('span.mm-record__k', { text: column.label }),
            el('span.mm-record__v', cellContent(column, row)))))));
    }
    return list;
  }

  function cellContent(column, row) {
    if (column.render) return column.render(row) ?? el('span.mm-empty-cell', { text: '—' });
    const value = row[column.key];
    if (value === null || value === undefined || value === '') {
      return el('span.mm-empty-cell', { text: '—' });
    }
    if (column.format === 'money') return el('span.mm-numeric', { text: fmt.money(value) });
    if (column.format === 'date') return el('span', { text: fmt.date(value) });
    if (column.format === 'datetime') return el('span', { text: fmt.dateTime(value) });
    if (column.format === 'relative') return el('span', { title: fmt.dateTime(value), text: fmt.relative(value) });
    if (column.format === 'number') return el('span.mm-numeric', { text: fmt.number(value) });
    if (column.format === 'label') return el('span', { text: fmt.label(value) });
    return el('span', { text: String(value) });
  }

  function paintBulkBar() {
    const count = state.selected.size;
    bulkBar.hidden = count === 0;
    if (!count) return;

    bulkBar.replaceChildren(
      el('span.mm-fw-medium', { text: `${fmt.number(count)} selected` }),
      el('span.mm-grow'),
      ...(bulkActions?.([...state.selected], { clear: clearSelection, refresh }) ?? []),
      button('Clear', { variant: 'ghost', size: 'sm', onClick: clearSelection }));
  }

  function clearSelection() {
    state.selected.clear();
    paintBulkBar();
    paint();
  }

  function buildPagination() {
    const total = state.meta?.pagination?.total ?? state.rows.length;
    const totalPages = state.meta?.pagination?.totalPages ?? 1;
    if (totalPages <= 1 && total <= state.pageSize) {
      return el('p.mm-muted.mm-text-sm.mm-mt-3', {
        text: `${fmt.number(total)} ${total === 1 ? 'result' : 'results'}`,
      });
    }

    const first = (state.page - 1) * state.pageSize + 1;
    const last = Math.min(state.page * state.pageSize, total);

    return el('nav.mm-pagination', { 'aria-label': 'Pagination' },
      el('span.mm-muted.mm-text-sm', {
        text: `${fmt.number(first)}–${fmt.number(last)} of ${fmt.number(total)}`,
      }),
      el('span.mm-grow'),
      el('div.mm-pagination__pages',
        el('button.mm-page-btn', {
          type: 'button', 'aria-label': 'Previous page',
          disabled: state.page <= 1,
          onClick: () => { state.page -= 1; refresh(); },
        }, icon('chevron-left', { size: 'sm' })),
        ...pageNumbers(state.page, totalPages).map(p => (p === '…'
          ? el('span.mm-muted', { text: '…' })
          : el('button.mm-page-btn', {
              type: 'button',
              class: p === state.page ? 'is-current' : '',
              'aria-current': p === state.page ? 'page' : null,
              text: String(p),
              onClick: () => { state.page = p; refresh(); },
            }))),
        el('button.mm-page-btn', {
          type: 'button', 'aria-label': 'Next page',
          disabled: state.page >= totalPages,
          onClick: () => { state.page += 1; refresh(); },
        }, icon('chevron-right', { size: 'sm' }))));
  }

  refresh();

  return {
    node: host,
    refresh,
    state,
    setFilter: applyFilter,
    selection: () => [...state.selected],
    clearSelection,
  };
}

/** 1 … 4 5 [6] 7 8 … 20 — enough context without a hundred buttons. */
function pageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);

  const out = [];
  let previous = 0;
  for (const page of sorted) {
    if (page - previous > 1) out.push('…');
    out.push(page);
    previous = page;
  }
  return out;
}

/** A <select> filter for a table toolbar. */
export function selectFilter({ label, options, value = '', onChange, allLabel = 'All' }) {
  return el('label.mm-filter',
    el('span.mm-sr-only', { text: label }),
    el('select.mm-select', {
      'aria-label': label,
      value,
      onChange: (e) => onChange(e.target.value || null),
    },
      el('option', { value: '', text: `${label}: ${allLabel}` }),
      ...options.map(option => el('option', {
        value: option.value ?? option,
        selected: (option.value ?? option) === value,
        text: option.label ?? fmt.label(option),
      }))));
}

/** A segmented tab strip with counts, for status tabs above a table. */
export function tabStrip({ tabs, active, onChange }) {
  return el('div.mm-tabs', { role: 'tablist' },
    ...tabs.map(tab => el('button.mm-tab', {
      type: 'button',
      role: 'tab',
      class: tab.key === active ? 'is-active' : '',
      'aria-selected': tab.key === active ? 'true' : 'false',
      onClick: () => onChange(tab.key),
    },
      el('span', { text: tab.label }),
      tab.count !== null && tab.count !== undefined
        ? el('span.mm-tab__count', { text: fmt.number(tab.count) })
        : null)));
}
