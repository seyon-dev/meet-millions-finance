/**
 * Charts, drawn as inline SVG.
 *
 * No charting library. These five shapes are what the product needs, they
 * inherit the theme's colours through currentColor and CSS variables, and
 * they redraw correctly when the theme changes — which a canvas-based library
 * would not without being told.
 *
 * Every chart renders an explicit empty state rather than an empty grid: a
 * blank axis looks like a bug, and a chart with no data should say so.
 */

import { el } from '../core/dom.js';
import * as fmt from '../core/format.js';

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

function chartEmpty(message) {
  return el('div.mm-chart-empty', { text: message });
}

/** Format a value according to the series' declared unit. */
function formatValue(value, unit) {
  if (unit === 'paise') return fmt.moneyShort(value);
  if (unit === 'percent') return `${value}%`;
  if (unit === 'seconds') return fmt.duration(value);
  return fmt.number(value);
}

// ---------------------------------------------------------------------------
// Bar
// ---------------------------------------------------------------------------
export function barChart({ series, unit = 'count', height = 200, emptyMessage = 'No data for this period.' }) {
  if (!series?.length || series.every(p => !p.value)) return chartEmpty(emptyMessage);

  const width = 640;
  const padding = { top: 16, right: 12, bottom: 28, left: 12 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const max = Math.max(...series.map(p => p.value ?? 0)) || 1;
  const slot = innerW / series.length;
  const barW = Math.min(slot * 0.55, 48);

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'mm-chart',
    role: 'img',
    'aria-label': `Bar chart: ${series.map(p => `${p.label} ${formatValue(p.value, unit)}`).join(', ')}`,
    preserveAspectRatio: 'none',
  });

  // Baseline. Without it the bars appear to float.
  root.append(svg('line', {
    x1: padding.left, x2: width - padding.right,
    y1: padding.top + innerH, y2: padding.top + innerH,
    class: 'mm-chart__baseline',
  }));

  series.forEach((point, i) => {
    const value = point.value ?? 0;
    const h = Math.max(2, (value / max) * innerH);
    const x = padding.left + i * slot + (slot - barW) / 2;
    const y = padding.top + innerH - h;

    const bar = svg('rect', {
      x, y, width: barW, height: h, rx: 6,
      class: `mm-chart__bar${point.highlight ? ' is-highlight' : ''}`,
    });
    bar.append(svg('title', {}));
    bar.lastChild.textContent = `${point.label}: ${formatValue(value, unit)}`;
    root.append(bar);

    root.append(text(padding.left + i * slot + slot / 2, height - 8, point.label, 'mm-chart__label'));
  });

  return root;
}

// ---------------------------------------------------------------------------
// Line / area
// ---------------------------------------------------------------------------
export function lineChart({ series, unit = 'count', height = 200, area = true, emptyMessage = 'No data yet.' }) {
  if (!series?.length) return chartEmpty(emptyMessage);
  if (series.length === 1) {
    return chartEmpty(`Only one data point so far (${series[0].label}: ${formatValue(series[0].value, unit)}). A trend needs at least two.`);
  }

  const width = 640;
  const padding = { top: 16, right: 12, bottom: 28, left: 12 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const values = series.map(p => p.value ?? 0);
  const max = Math.max(...values) || 1;
  const step = innerW / (series.length - 1);

  const points = series.map((point, i) => [
    padding.left + i * step,
    padding.top + innerH - ((point.value ?? 0) / max) * innerH,
  ]);

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'mm-chart',
    role: 'img',
    'aria-label': `Line chart: ${series.map(p => `${p.label} ${formatValue(p.value, unit)}`).join(', ')}`,
    preserveAspectRatio: 'none',
  });

  root.append(svg('line', {
    x1: padding.left, x2: width - padding.right,
    y1: padding.top + innerH, y2: padding.top + innerH,
    class: 'mm-chart__baseline',
  }));

  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  if (area) {
    root.append(svg('path', {
      d: `${path} L${points[points.length - 1][0]},${padding.top + innerH} L${points[0][0]},${padding.top + innerH} Z`,
      class: 'mm-chart__area',
    }));
  }
  root.append(svg('path', { d: path, class: 'mm-chart__line' }));

  points.forEach(([x, y], i) => {
    const dot = svg('circle', { cx: x, cy: y, r: 3.5, class: 'mm-chart__dot' });
    dot.append(svg('title', {}));
    dot.lastChild.textContent = `${series[i].label}: ${formatValue(series[i].value, unit)}`;
    root.append(dot);
  });

  // Only the ends and the middle are labelled — a label per point overlaps.
  const labelled = series.length <= 7
    ? series.map((_, i) => i)
    : [0, Math.floor(series.length / 2), series.length - 1];
  for (const i of labelled) {
    root.append(text(points[i][0], height - 8, series[i].label, 'mm-chart__label'));
  }

  return root;
}

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------
export function donutChart({ series, size = 200, emptyMessage = 'Nothing to show yet.', centreLabel = null }) {
  const data = (series ?? []).filter(s => (s.value ?? 0) > 0);
  if (!data.length) return chartEmpty(emptyMessage);

  const total = data.reduce((sum, s) => sum + s.value, 0);
  const radius = size / 2;
  const stroke = size * 0.18;
  const r = radius - stroke / 2;
  const circumference = 2 * Math.PI * r;

  const root = svg('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'mm-chart mm-chart--donut',
    role: 'img',
    'aria-label': `Breakdown: ${data.map(s => `${fmt.label(s.label)} ${s.value}`).join(', ')}`,
  });

  let offset = 0;
  data.forEach((slice, i) => {
    const fraction = slice.value / total;
    const arc = svg('circle', {
      cx: radius, cy: radius, r,
      fill: 'none',
      'stroke-width': stroke,
      'stroke-dasharray': `${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
      'stroke-dashoffset': (-offset * circumference).toFixed(2),
      transform: `rotate(-90 ${radius} ${radius})`,
      class: `mm-chart__arc mm-chart__arc--${slice.tone ?? toneFor(i)}`,
      'stroke-linecap': 'butt',
    });
    arc.append(svg('title', {}));
    arc.lastChild.textContent = `${fmt.label(slice.label)}: ${slice.value} (${Math.round(fraction * 100)}%)`;
    root.append(arc);
    offset += fraction;
  });

  root.append(text(radius, radius - 2, centreLabel ?? fmt.number(total), 'mm-chart__center-v'));
  root.append(text(radius, radius + 16, centreLabel ? '' : 'TOTAL', 'mm-chart__center-k'));

  return root;
}

/** The legend that belongs beside a donut. */
export function legend(series) {
  const data = (series ?? []).filter(s => (s.value ?? 0) > 0);
  const total = data.reduce((sum, s) => sum + s.value, 0) || 1;

  return el('ul.mm-legend',
    ...data.map((slice, i) => el('li.mm-legend__item',
      el('span.mm-legend__swatch', { class: `mm-legend__swatch--${slice.tone ?? toneFor(i)}` }),
      el('span.mm-legend__label', { text: fmt.label(slice.label) }),
      el('span.mm-legend__value', {
        text: `${fmt.number(slice.value)} · ${Math.round((slice.value / total) * 100)}%`,
      }))));
}

// ---------------------------------------------------------------------------
// Sparkline — small enough to sit inside a stat tile
// ---------------------------------------------------------------------------
export function sparkline(values, { width = 96, height = 28, tone = 'brand' } = {}) {
  const data = (values ?? []).map(v => Number(v) || 0);
  if (data.length < 2) return el('span');

  const max = Math.max(...data) || 1;
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);

  const path = data
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(' ');

  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: `mm-spark mm-spark--${tone}`,
    'aria-hidden': 'true',
    preserveAspectRatio: 'none',
  });
  root.append(svg('path', { d: path, class: 'mm-spark__line' }));
  return root;
}

// ---------------------------------------------------------------------------
// Horizontal ranked bars — leaderboards
// ---------------------------------------------------------------------------
export function rankBars({ rows, unit = 'count', emptyMessage = 'No activity recorded yet.' }) {
  if (!rows?.length) return chartEmpty(emptyMessage);
  const max = Math.max(...rows.map(r => r.value ?? 0)) || 1;

  return el('ul.mm-rankbar',
    ...rows.map(row => el('li.mm-rankbar__row',
      el('span.mm-rankbar__label', { text: row.label, title: row.label }),
      el('span.mm-rankbar__track',
        el('span.mm-rankbar__fill', {
          class: row.tone ? `mm-rankbar__fill--${row.tone}` : '',
          style: { width: `${Math.max(2, ((row.value ?? 0) / max) * 100)}%` },
        })),
      el('span.mm-rankbar__val', { text: row.valueLabel ?? formatValue(row.value, unit) }))));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function text(x, y, content, className) {
  const node = svg('text', { x, y, 'text-anchor': 'middle', class: className });
  node.textContent = content;
  return node;
}

const TONES = ['brand', 'accent', 'success', 'warning', 'danger', 'violet', 'neutral'];
function toneFor(index) { return TONES[index % TONES.length]; }
