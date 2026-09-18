/**
 * A small PDF writer.
 *
 * The product needs genuine PDF downloads for reports, invoices and receipts.
 * Rather than ship a large dependency into a Worker, this emits a valid PDF
 * 1.4 document directly: an object table, a page tree, and content streams
 * built from the standard Type 1 fonts every reader has (Helvetica and
 * Helvetica-Bold), so no font needs embedding.
 *
 * It supports what a financial document actually needs: a header band, headings,
 * paragraphs, key/value rows, ruled tables with right-aligned money columns,
 * totals, page breaks and a numbered footer. That is the whole scope — it is a
 * document writer, not a layout engine.
 */

const PAGE = { width: 595.28, height: 841.89 };   // A4 in points
const MARGIN = { top: 56, right: 48, bottom: 56, left: 48 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

/** Widths per 1000 units for Helvetica, used to measure and truncate text. */
const HELVETICA_WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

function charWidth(ch, bold) {
  const base = HELVETICA_WIDTHS[ch] ?? 556;
  return bold ? base * 1.06 : base;   // Helvetica-Bold runs slightly wider
}

export function measure(text, size, bold = false) {
  let total = 0;
  for (const ch of String(text)) total += charWidth(ch, bold);
  return (total / 1000) * size;
}

function truncate(text, maxWidth, size, bold = false) {
  const s = String(text ?? '');
  if (measure(s, size, bold) <= maxWidth) return s;
  let out = '';
  for (const ch of s) {
    if (measure(out + ch + '…', size, bold) > maxWidth) break;
    out += ch;
  }
  return out + '…';
}

function wrap(text, maxWidth, size, bold = false) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size, bold) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Escape a string for a PDF literal, and drop characters WinAnsi cannot show. */
function pdfString(text) {
  return String(text ?? '')
    .replace(/₹/g, 'Rs. ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

export class PdfDocument {
  constructor({ title = 'Document', author = 'Meet Millions Finance CRM', subject = '' } = {}) {
    this.meta = { title, author, subject };
    this.pages = [];
    this.current = null;
    this.y = 0;
    this.pageNumber = 0;
    this.footerText = '';
    this.addPage();
  }

  addPage() {
    this.pageNumber += 1;
    this.current = { ops: [], number: this.pageNumber };
    this.pages.push(this.current);
    this.y = PAGE.height - MARGIN.top;
    return this.current;
  }

  /** Reserve vertical space, breaking to a new page when it will not fit. */
  need(height) {
    if (this.y - height < MARGIN.bottom + 24) this.addPage();
  }

  op(s) { this.current.ops.push(s); }

  setFill(hex) {
    const { r, g, b } = hexToRgb(hex);
    this.op(`${r} ${g} ${b} rg`);
  }
  setStroke(hex) {
    const { r, g, b } = hexToRgb(hex);
    this.op(`${r} ${g} ${b} RG`);
  }

  text(content, x, y, { size = 10, bold = false, colour = '#101A2E', align = 'left', width = CONTENT_WIDTH } = {}) {
    const str = pdfString(content);
    if (!str) return;
    let drawX = x;
    if (align === 'right') drawX = x + width - measure(str, size, bold);
    else if (align === 'center') drawX = x + (width - measure(str, size, bold)) / 2;

    this.setFill(colour);
    this.op('BT');
    this.op(`/${bold ? 'F2' : 'F1'} ${size} Tf`);
    this.op(`1 0 0 1 ${round(drawX)} ${round(y)} Tm`);
    this.op(`(${str}) Tj`);
    this.op('ET');
  }

  rect(x, y, w, h, colour) {
    this.setFill(colour);
    this.op(`${round(x)} ${round(y)} ${round(w)} ${round(h)} re f`);
  }

  line(x1, y1, x2, y2, colour = '#E1E8F4', widthPt = 0.6) {
    this.setStroke(colour);
    this.op(`${widthPt} w`);
    this.op(`${round(x1)} ${round(y1)} m ${round(x2)} ${round(y2)} l S`);
  }

  // ---- High-level blocks ---------------------------------------------------

  /** The branded band at the top of the first page. */
  header({ brand, title, subtitle, right = [] }) {
    this.rect(0, PAGE.height - 92, PAGE.width, 92, '#0D1526');
    this.rect(0, PAGE.height - 96, PAGE.width, 4, '#2F6BFF');

    this.text(brand, MARGIN.left, PAGE.height - 42, { size: 13, bold: true, colour: '#FFFFFF' });
    this.text(title, MARGIN.left, PAGE.height - 64, { size: 17, bold: true, colour: '#FFFFFF' });
    if (subtitle) this.text(subtitle, MARGIN.left, PAGE.height - 80, { size: 9, colour: '#A9B8D4' });

    let ry = PAGE.height - 42;
    for (const item of right) {
      this.text(item.label, MARGIN.left, ry, {
        size: 7.5, colour: '#7386AA', align: 'right', width: CONTENT_WIDTH });
      this.text(item.value, MARGIN.left, ry - 12, {
        size: 10, bold: true, colour: '#FFFFFF', align: 'right', width: CONTENT_WIDTH });
      ry -= 28;
    }

    this.y = PAGE.height - 124;
  }

  heading(text, { size = 12, spacing = 18 } = {}) {
    this.need(spacing + 10);
    this.y -= spacing;
    this.text(text, MARGIN.left, this.y, { size, bold: true });
    this.y -= 6;
    this.line(MARGIN.left, this.y, PAGE.width - MARGIN.right, this.y, '#E1E8F4');
    this.y -= 10;
  }

  eyebrow(text) {
    this.need(16);
    this.y -= 14;
    this.text(String(text).toUpperCase(), MARGIN.left, this.y, { size: 7.5, bold: true, colour: '#6B7CA0' });
    this.y -= 4;
  }

  paragraph(text, { size = 9.5, colour = '#334155', spacing = 12 } = {}) {
    const lines = wrap(text, CONTENT_WIDTH, size);
    for (const line of lines) {
      this.need(size + 4);
      this.y -= size + 3.5;
      this.text(line, MARGIN.left, this.y, { size, colour });
    }
    this.y -= spacing - 8;
  }

  /** A two-column key/value block, e.g. billing details. */
  keyValues(pairs, { columns = 2, size = 9 } = {}) {
    const colWidth = CONTENT_WIDTH / columns;
    let index = 0;
    while (index < pairs.length) {
      this.need(26);
      this.y -= 24;
      for (let c = 0; c < columns && index < pairs.length; c++, index++) {
        const [label, value] = pairs[index];
        const x = MARGIN.left + c * colWidth;
        this.text(String(label).toUpperCase(), x, this.y + 11, { size: 7, colour: '#6B7CA0' });
        this.text(truncate(value, colWidth - 12, size, false), x, this.y, { size, colour: '#101A2E' });
      }
    }
    this.y -= 6;
  }

  /** Summary tiles across the page — the totals band on a tax report. */
  tiles(items) {
    const gap = 8;
    const tileWidth = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
    this.need(56);
    this.y -= 50;
    items.forEach((item, i) => {
      const x = MARGIN.left + i * (tileWidth + gap);
      this.rect(x, this.y, tileWidth, 46, item.highlight ? '#EAF1FF' : '#F6F8FC');
      this.text(truncate(String(item.label).toUpperCase(), tileWidth - 16, 6.5, false), x + 8, this.y + 30,
        { size: 6.5, colour: '#6B7CA0' });
      // Shrink a long figure to fit its tile rather than clipping it — a
      // truncated amount on a tax report is worse than a small one.
      let valueSize = 12;
      while (valueSize > 7.5 && measure(item.value, valueSize, true) > tileWidth - 16) valueSize -= 0.5;
      this.text(truncate(item.value, tileWidth - 16, valueSize, true), x + 8, this.y + 12, {
        size: valueSize, bold: true, colour: item.highlight ? '#1E52E0' : '#101A2E' });
    });
    this.y -= 10;
  }

  /**
   * A ruled table.
   * @param {{label:string, key:string, width:number, align?:string, bold?:boolean}[]} columns
   *        widths are fractions of the content width and should sum to 1
   */
  table(columns, rows, { size = 8.5, rowHeight = 17, zebra = true } = {}) {
    const widths = columns.map(c => c.width * CONTENT_WIDTH);

    const drawHead = () => {
      this.need(rowHeight + 8);
      this.y -= rowHeight;
      this.rect(MARGIN.left, this.y, CONTENT_WIDTH, rowHeight, '#F3F6FC');
      let x = MARGIN.left;
      columns.forEach((col, i) => {
        this.text(truncate(String(col.label).toUpperCase(), widths[i] - 10, 7, true), x + 5, this.y + 5.5, {
          size: 7, bold: true, colour: '#46587C',
          align: col.align === 'right' ? 'right' : 'left', width: widths[i] - 10,
        });
        x += widths[i];
      });
    };

    drawHead();

    rows.forEach((row, rowIndex) => {
      if (this.y - rowHeight < MARGIN.bottom + 24) {
        this.addPage();
        drawHead();
      }
      this.y -= rowHeight;
      if (zebra && rowIndex % 2 === 1) {
        this.rect(MARGIN.left, this.y, CONTENT_WIDTH, rowHeight, '#FBFCFE');
      }
      let x = MARGIN.left;
      columns.forEach((col, i) => {
        const value = row[col.key] ?? '';
        this.text(truncate(value, widths[i] - 10, size, col.bold), x + 5, this.y + 5, {
          size, bold: !!col.bold, colour: col.muted ? '#46587C' : '#101A2E',
          align: col.align === 'right' ? 'right' : 'left', width: widths[i] - 10,
        });
        x += widths[i];
      });
      this.line(MARGIN.left, this.y, PAGE.width - MARGIN.right, this.y, '#EEF2F9', 0.4);
    });

    this.y -= 8;
  }

  /** A right-aligned totals block under a table. */
  totals(rows) {
    const boxWidth = 240;
    const x = PAGE.width - MARGIN.right - boxWidth;
    for (const [label, value, emphasis] of rows) {
      this.need(20);
      this.y -= 18;
      if (emphasis) this.rect(x, this.y - 3, boxWidth, 20, '#EAF1FF');
      this.text(label, x + 8, this.y + 2, { size: emphasis ? 9.5 : 9, bold: !!emphasis, colour: '#46587C' });
      this.text(value, x, this.y + 2, {
        size: emphasis ? 11 : 9.5, bold: true, colour: emphasis ? '#1E52E0' : '#101A2E',
        align: 'right', width: boxWidth - 8,
      });
    }
    this.y -= 10;
  }

  note(text) {
    this.need(30);
    this.y -= 24;
    this.rect(MARGIN.left, this.y - 4, CONTENT_WIDTH, 26, '#FEF6E7');
    const lines = wrap(text, CONTENT_WIDTH - 20, 8);
    let ty = this.y + 12;
    for (const line of lines.slice(0, 2)) {
      this.text(line, MARGIN.left + 10, ty, { size: 8, colour: '#B45309' });
      ty -= 10;
    }
    this.y -= 10;
  }

  footer(text) { this.footerText = text; }

  /** Serialise to PDF bytes. */
  render() {
    const total = this.pages.length;

    // Paint the footer on every page now that the count is known.
    for (const page of this.pages) {
      const saved = this.current;
      this.current = page;
      this.line(MARGIN.left, MARGIN.bottom - 6, PAGE.width - MARGIN.right, MARGIN.bottom - 6, '#E1E8F4');
      this.text(this.footerText, MARGIN.left, MARGIN.bottom - 18, { size: 7.5, colour: '#6B7CA0' });
      this.text(`Page ${page.number} of ${total}`, MARGIN.left, MARGIN.bottom - 18, {
        size: 7.5, colour: '#6B7CA0', align: 'right', width: CONTENT_WIDTH });
      this.current = saved;
    }

    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };

    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    const pagesObjNumber = objects.length + 1 + this.pages.length * 2 + 1;
    const pageRefs = [];

    for (const page of this.pages) {
      const stream = page.ops.join('\n');
      const contentNumber = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageNumber = add(
        `<< /Type /Page /Parent ${pagesObjNumber} 0 R ` +
        `/MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
        `/Contents ${contentNumber} 0 R >>`);
      pageRefs.push(pageNumber);
    }

    const pagesNumber = add(
      `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.map(n => `${n} 0 R`).join(' ')}] >>`);
    const infoNumber = add(
      `<< /Title (${pdfString(this.meta.title)}) /Author (${pdfString(this.meta.author)}) ` +
      `/Subject (${pdfString(this.meta.subject)}) /Producer (Meet Millions Finance CRM) ` +
      `/CreationDate (D:${pdfDate(new Date())}) >>`);
    const catalogNumber = add(`<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`);

    let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
      pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R /Info ${infoNumber} 0 R >>\n`;
    pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
    return bytes;
  }
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  return {
    r: round(parseInt(full.slice(0, 2), 16) / 255, 4),
    g: round(parseInt(full.slice(2, 4), 16) / 255, 4),
    b: round(parseInt(full.slice(4, 6), 16) / 255, 4),
  };
}

function round(n, places = 2) {
  return Number(Number(n).toFixed(places));
}

function pdfDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
         `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export { PAGE, MARGIN, CONTENT_WIDTH, wrap, truncate, pdfString };
