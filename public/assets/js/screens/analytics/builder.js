/**
 * The report builder.
 *
 * Pick a dataset, pick columns, add filters, run it. The SQL the server
 * actually ran comes back with the results and is shown — a builder that hides
 * what it asked the database is a builder whose numbers cannot be defended.
 *
 * Everything the builder can reach is tenant-scoped on the server. This screen
 * cannot widen that, and does not try to.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, button, iconButton, pill, emptyState, errorState, skeletonTable,
  notify, notifyError, modal, promptText, lockedState,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function builderScreen() {
  setBreadcrumbs([{ label: 'Analytics', href: '/analytics' }, { label: 'Report builder' }]);

  const page = el('div.mm-page');
  render(page, skeletonTable(6, 4));

  let catalogue;
  try {
    ({ data: catalogue } = await api.get('/analytics/datasets'));
  } catch (err) {
    if (err.name === 'FeatureLocked') {
      render(page,
        pageHead({ title: 'Report builder' }),
        lockedState({
          featureName: 'The report builder',
          requiredAddOn: 'advanced_analytics',
          message: 'Build your own reports across clients, documents, invoices and filings.',
        }));
      return page;
    }
    render(page, errorState(err));
    return page;
  }

  const savedHost = el('div.mm-mt-4');
  const state = {
    dataset: catalogue.datasets[0]?.key ?? null,
    fields: [],
    filters: [],
    groupBy: null,
    aggregate: null,
    orderBy: null,
    orderDir: 'desc',
    limit: 200,
  };

  // Start with the first four columns of the first dataset, so running it
  // immediately produces something rather than an error about no columns.
  state.fields = (catalogue.datasets[0]?.fields ?? []).slice(0, 4).map(f => f.key);

  const formHost = el('div');
  const resultHost = el('div');

  function dataset() {
    return catalogue.datasets.find(d => d.key === state.dataset) ?? catalogue.datasets[0];
  }

  function paintForm() {
    const active = dataset();

    const datasetSelect = el('select.mm-select', {
      onChange: (e) => {
        state.dataset = e.target.value;
        const next = catalogue.datasets.find(d => d.key === state.dataset);
        state.fields = (next?.fields ?? []).slice(0, 4).map(f => f.key);
        state.filters = [];
        state.groupBy = null;
        state.aggregate = null;
        state.orderBy = null;
        paintForm();
      },
    },
      ...catalogue.datasets.map(d => el('option', {
        value: d.key, selected: d.key === state.dataset, text: d.label,
      })));

    const fieldToggles = el('div.mm-row.mm-gap-2.mm-wrap',
      ...(active?.fields ?? []).map(field => el('label.mm-chip.mm-chip--check', {
        class: state.fields.includes(field.key) ? 'is-on' : '',
      },
        el('input.mm-sr-only', {
          type: 'checkbox',
          checked: state.fields.includes(field.key),
          onChange: (e) => {
            state.fields = e.target.checked
              ? [...state.fields, field.key]
              : state.fields.filter(k => k !== field.key);
            paintForm();
          },
        }),
        el('span', { text: field.label }),
        el('span.mm-muted.mm-text-2xs', { text: field.type }))));

    const filtersHost = el('div.mm-stack.mm-gap-2');
    const paintFilters = () => {
      render(filtersHost, ...state.filters.map((filter, index) => {
        const fieldSelect = el('select.mm-select', {
          onChange: (e) => { filter.field = e.target.value; },
        },
          ...(active?.fields ?? []).map(f => el('option', {
            value: f.key, selected: f.key === filter.field, text: f.label,
          })));

        const operatorSelect = el('select.mm-select', {
          onChange: (e) => { filter.op = e.target.value; paintFilters(); },
        },
          ...catalogue.operators.map(o => el('option', {
            value: o.key, selected: o.key === filter.op, text: o.label,
          })));

        const needsValue = catalogue.operators.find(o => o.key === filter.op)?.needsValue !== false;
        const valueInput = el('input.mm-input', {
          value: filter.value ?? '',
          disabled: !needsValue,
          placeholder: needsValue ? 'Value' : 'No value needed',
          onInput: (e) => { filter.value = e.target.value; },
        });

        return el('div.mm-row.mm-gap-2.mm-wrap',
          fieldSelect, operatorSelect, valueInput,
          iconButton('trash', {
            label: 'Remove this filter',
            onClick: () => { state.filters.splice(index, 1); paintFilters(); },
          }));
      }));
    };
    paintFilters();

    const groupSelect = el('select.mm-select', {
      onChange: (e) => { state.groupBy = e.target.value || null; },
    },
      el('option', { value: '', text: 'No grouping — one row per record' }),
      ...(active?.fields ?? []).map(f => el('option', {
        value: f.key, selected: f.key === state.groupBy, text: `Group by ${f.label}`,
      })));

    const aggregateSelect = el('select.mm-select', {
      onChange: (e) => {
        state.aggregate = e.target.value ? { fn: e.target.value } : null;
        paintForm();
      },
    },
      el('option', { value: '', text: 'No aggregate' }),
      ...catalogue.aggregates.map(a => el('option', {
        value: a.key, selected: a.key === state.aggregate?.fn, text: a.label,
      })));

    const aggregateField = state.aggregate
      ? el('select.mm-select', {
          onChange: (e) => { state.aggregate.field = e.target.value; },
        },
          ...(active?.fields ?? [])
            .filter(f => ['number', 'money', 'int'].includes(f.type) || state.aggregate.fn === 'count')
            .map(f => el('option', {
              value: f.key, selected: f.key === state.aggregate.field, text: f.label,
            })))
      : null;

    const limitInput = el('input.mm-input', {
      type: 'number', min: '1', max: '5000', value: String(state.limit),
      onInput: (e) => { state.limit = Number(e.target.value) || 200; },
    });

    render(formHost, card({
      title: 'What would you like to see?',
      actions: frag(
        button('Add a filter', {
          variant: 'ghost', size: 'sm', icon: 'filter',
          onClick: () => {
            state.filters.push({
              field: active?.fields?.[0]?.key,
              op: catalogue.operators[0]?.key,
              value: '',
            });
            paintFilters();
          },
        }),
        button('Run', { variant: 'primary', size: 'sm', icon: 'play', onClick: run })),
      body: frag(
        el('div.mm-field', el('label.mm-field__label', { text: 'Dataset' }), datasetSelect),

        el('div.mm-field',
          el('label.mm-field__label', { text: `Columns (${state.fields.length} chosen)` }),
          fieldToggles),

        state.filters.length
          ? el('div.mm-field', el('label.mm-field__label', { text: 'Only rows where' }), filtersHost)
          : null,

        el('div.mm-grid.mm-grid-3.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Grouping' }), groupSelect),
          el('div.mm-field',
            el('label.mm-field__label', { text: 'Aggregate' }),
            el('div.mm-row.mm-gap-2', aggregateSelect, aggregateField)),
          el('div.mm-field', el('label.mm-field__label', { text: 'Row limit' }), limitInput))),
    }));
  }

  async function run() {
    if (!state.fields.length) {
      notify.warning('Choose at least one column.');
      return;
    }

    render(resultHost, skeletonTable(8, state.fields.length));
    try {
      const { data } = await api.post('/analytics/query', payload());
      render(resultHost, resultCard(data, payload, paintSaved));
    } catch (err) {
      render(resultHost, errorState(err, { onRetry: run }));
    }
  }

  function payload() {
    return {
      dataset: state.dataset,
      fields: state.fields,
      filters: state.filters.filter(f => f.field && f.op),
      groupBy: state.groupBy ?? undefined,
      aggregate: state.aggregate?.fn ? state.aggregate : undefined,
      orderBy: state.orderBy ?? undefined,
      orderDir: state.orderDir,
      limit: state.limit,
    };
  }

  /**
   * Saved reports.
   *
   * Saving promised "it can be re-run" while nothing anywhere listed what had
   * been saved — the promise pointed at a screen that did not exist. This is
   * that screen's missing half: the saved queries, each loading back into the
   * builder and running.
   */
  async function paintSaved() {
    try {
      const { data } = await api.get('/analytics/dashboards');
      const saved = (data.dashboards ?? []).filter(d => d.widgets?.[0]?.query);
      if (!saved.length) { render(savedHost, null); return; }

      render(savedHost, card({
        title: 'Saved reports',
        flush: true,
        body: el('ul.mm-list',
          ...saved.map(d => el('li.mm-list__row',
            el('span.mm-list__icon.mm-c-brand', icon('file-text', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: d.name }),
              el('span.mm-muted.mm-text-xs', {
                text: `${d.widgets[0].query.dataset} · saved ${fmt.relative(d.createdAt ?? d.created_at)}`,
              })),
            el('div.mm-row.mm-gap-1',
              button('Run', {
                size: 'xs', variant: 'ghost',
                onClick: () => {
                  const q = d.widgets[0].query;
                  Object.assign(state, {
                    dataset: q.dataset,
                    fields: q.fields ?? [],
                    filters: q.filters ?? [],
                    groupBy: q.groupBy ?? null,
                    aggregate: q.aggregate ?? null,
                    orderBy: q.orderBy ?? null,
                    orderDir: q.orderDir ?? 'desc',
                    limit: q.limit ?? 200,
                  });
                  paintForm();
                  run();
                },
              }),
              button('Delete', {
                size: 'xs', variant: 'ghost',
                onClick: async () => {
                  try {
                    await api.delete(`/analytics/dashboards/${d.id}`);
                    notify.success('Deleted.');
                    paintSaved();
                  } catch (err) { notifyError(err); }
                },
              }))))),
      }));
    } catch {
      // The saved list is a convenience; the builder works without it.
      render(savedHost, null);
    }
  }

  page.replaceChildren();
  page.append(
    pageHead({
      title: 'Report builder',
      subtitle: 'Your own questions, against your own data.',
      actions: button('Trends', { variant: 'ghost', icon: 'bar-chart', href: '/analytics' }),
    }),
    formHost,
    savedHost,
    resultHost);

  paintForm();
  await Promise.all([run(), paintSaved()]);
  return page;
}

function resultCard(data, payload, onSaved) {
  const columns = data.columns ?? [];
  const rows = data.rows ?? [];

  return card({
    title: `${fmt.plural(data.rowCount ?? rows.length, 'row')}`,
    subtitle: data.truncated ? 'Truncated at the row limit — raise it to see more.' : null,
    actions: frag(
      button('Download CSV', {
        variant: 'ghost', size: 'sm', icon: 'download',
        onClick: () => downloadCsv(payload()),
      }),
      button('Save this report', {
        variant: 'ghost', size: 'sm', icon: 'plus',
        onClick: () => saveDashboard(payload(), onSaved),
      })),
    flush: true,
    body: frag(
      rows.length
        ? el('div.mm-table-wrap',
            el('table.mm-table.mm-table--compact',
              el('thead',
                el('tr', ...columns.map(column => el('th', {
                  class: ['money', 'number', 'int'].includes(column.type) ? 'mm-align-right' : '',
                  text: column.label,
                })))),
              el('tbody',
                ...rows.map(row => el('tr',
                  ...columns.map(column => el('td', {
                    class: ['money', 'number', 'int'].includes(column.type) ? 'mm-align-right mm-numeric' : '',
                    text: cellText(row, column),
                  })))))))
        : emptyState({
            title: 'Nothing matched',
            message: 'Loosen a filter, or choose a different dataset.',
            icon: 'search',
            inline: true,
          }),

      data.explain
        ? el('details.mm-details.mm-p-4',
            el('summary', { text: 'What was asked of the database' }),
            el('pre.mm-code.mm-mt-2', { text: data.explain }))
        : null),
  });
}

function cellText(row, column) {
  if (column.type === 'money') return row[`${column.key}_label`] ?? fmt.money(row[column.key] ?? 0);
  const value = row[column.key];
  if (value === null || value === undefined || value === '') return '—';
  if (column.type === 'date') return fmt.date(value);
  if (column.type === 'datetime') return fmt.dateTime(value);
  if (column.type === 'number' || column.type === 'int') return fmt.number(value);
  return String(value);
}

async function downloadCsv(query) {
  try {
    // The CSV is produced by the same query the table came from, so the file
    // and the screen can never disagree.
    const response = await api.raw('/analytics/query', {
      method: 'POST',
      body: { ...query, format: 'csv' },
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${query.dataset}-report.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify.success('Downloaded.');
  } catch (err) {
    notifyError(err);
  }
}

async function saveDashboard(query, onSaved) {
  const name = await promptText({
    title: 'Save this report',
    message: 'It appears under Saved reports on this screen, ready to re-run.',
    label: 'Name',
    placeholder: 'Clients with outstanding invoices',
    multiline: false,
    confirmLabel: 'Save',
  });
  if (!name) return;

  try {
    // A dashboard is a set of widgets, each carrying its own query; saving one
    // report saves a dashboard with a single widget.
    await api.post('/analytics/dashboards', {
      name,
      widgets: [{ title: name, type: 'table', query }],
    });
    notify.success('Saved. It is under Saved reports below.');
    onSaved?.();
  } catch (err) {
    notifyError(err);
  }
}
