/**
 * A list screen, assembled from a description.
 *
 * Most of this application's screens are the same shape: a heading, optional
 * summary tiles, optional status tabs, a filtered table, and a row action.
 * Writing each one by hand would mean twenty chances to get the loading state,
 * the empty state or the mobile fallback subtly different.
 *
 * Anything that is genuinely its own screen — the verification workspace, the
 * dial pad, the report builder — is written by hand instead.
 */

import { el, frag, render } from '../core/dom.js';
import { api } from '../core/api.js';
import * as router from '../core/router.js';
import * as session from '../core/session.js';
import * as fmt from '../core/format.js';
import {
  pageHead, card, stat, button, errorState, lockedState, skeletonTiles, statusPill,
} from '../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../components/table.js';
import { setBreadcrumbs } from '../layout/shell.js';

/**
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} [spec.subtitle]
 * @param {string} spec.endpoint          the API path to list from
 * @param {object[]} spec.columns         passed to dataTable
 * @param {(meta) => object[]} [spec.tiles]   summary tiles from the list's meta
 * @param {object[]} [spec.tabs]          status tabs; each { key, label, params }
 * @param {(row) => string} [spec.rowHref]
 */
export function listScreen(spec) {
  return async function render_({ query }) {
    setBreadcrumbs(spec.breadcrumbs ?? [{ label: spec.title }]);

    const page = el('div.mm-page');
    const tileHost = el('div');
    const tabHost = el('div');

    let activeTab = query.get('tab') ?? spec.tabs?.[0]?.key ?? null;
    let table = null;

    const build = () => {
      table = dataTable({
        ...spec.table,
        columns: spec.columns,
        searchPlaceholder: spec.searchPlaceholder ?? 'Search…',
        defaultSort: spec.defaultSort,
        defaultDir: spec.defaultDir,
        filters: spec.filters,
        toolbar: spec.toolbar,
        selectable: spec.selectable,
        bulkActions: spec.bulkActions,
        empty: spec.empty ?? { title: `No ${spec.title.toLowerCase()} yet`, icon: 'inbox' },
        onRowClick: spec.rowHref ? (row) => router.go(spec.rowHref(row)) : spec.onRowClick,
        load: async (params) => {
          const tabParams = spec.tabs?.find(t => t.key === activeTab)?.params ?? {};
          const { data, meta } = await api.get(spec.endpoint, { ...tabParams, ...params });
          paintTiles(meta);
          paintTabs(meta);
          return { rows: data ?? [], meta };
        },
      });
      return table.node;
    };

    function paintTiles(meta) {
      if (!spec.tiles) return;
      const tiles = spec.tiles(meta) ?? [];
      render(tileHost, tiles.length
        ? el('div.mm-grid.mm-grid-4.mm-gap-4', ...tiles.map(t => stat(t)))
        : null);
    }

    function paintTabs(meta) {
      if (!spec.tabs) return;
      render(tabHost, tabStrip({
        tabs: spec.tabs.map(tab => ({
          key: tab.key,
          label: tab.label,
          count: tab.count ? tab.count(meta) : null,
        })),
        active: activeTab,
        onChange: (key) => {
          activeTab = key;
          router.setQuery({ tab: key === spec.tabs[0].key ? null : key });
          table.state.page = 1;
          table.refresh();
        },
      }));
    }

    if (spec.tiles) render(tileHost, skeletonTiles(4));

    try {
      page.append(
        pageHead({
          title: spec.title,
          subtitle: spec.subtitle,
          actions: spec.actions ? spec.actions({ refresh: () => table?.refresh() }) : null,
        }),
        tileHost,
        tabHost,
        card({ body: build(), flush: true }));
    } catch (err) {
      page.append(errorState(err));
    }

    return page;
  };
}

/** A column showing a status as a coloured pill. */
export function statusColumn(key = 'status', label = 'Status') {
  return { key, label, render: (row) => statusPill(row[key]) };
}

/** A column showing money held as integer paise. */
export function moneyColumn(key, label, { align = 'right' } = {}) {
  return {
    key,
    label,
    align,
    render: (row) => el('span.mm-numeric', { text: fmt.money(row[key] ?? 0) }),
  };
}

/** A two-line cell: a title with something quieter beneath it. */
export function stackedColumn(key, label, { title, sub, primary = false, sortable = false }) {
  return {
    key,
    label,
    primary,
    sortable,
    render: (row) => el('div.mm-stack',
      el('span.mm-fw-medium', { text: title(row) ?? '—' }),
      sub(row) ? el('span.mm-muted.mm-text-xs', { text: sub(row) }) : null),
  };
}

export { selectFilter, tabStrip };
