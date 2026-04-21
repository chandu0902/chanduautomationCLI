#!/usr/bin/env node
/**
 * Converts the latest btc_full_report_pair20_*.txt into a formatted .docx
 * Usage:  node scripts/generateReportDoc.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, HeadingLevel, AlignmentType, WidthType, BorderStyle,
  ShadingType, convertInchesToTwip,
} = require('docx');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// ── find latest report txt ────────────────────────────────────────────────────
const txts = fs.readdirSync(REPORTS_DIR)
  .filter((f) => f.startsWith('btc_full_report_pair20_') && f.endsWith('.txt'))
  .sort();
if (!txts.length) { console.error('No report txt found in', REPORTS_DIR); process.exit(1); }
const txtPath = path.join(REPORTS_DIR, txts[txts.length - 1]);
console.log('Source:', txtPath);

// ── colour palette ────────────────────────────────────────────────────────────
const C = {
  navy:      '1B3A5C',
  gold:      'D4A017',
  darkGold:  'A87C10',
  white:     'FFFFFF',
  lightGray: 'F2F4F7',
  midGray:   'D0D5DD',
  darkText:  '1A1A2E',
  green:     '0A6640',
  greenBg:   'E6F4EC',
  red:       'A60C00',
  redBg:     'FDECEA',
  blueBg:    'E8F0FB',
  blueAccent:'1A56DB',
};

// ── helpers ───────────────────────────────────────────────────────────────────

/** Bold navy heading paragraph */
function heading1(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 26, color: C.white, font: 'Calibri' })],
    heading: HeadingLevel.HEADING_1,
    shading: { type: ShadingType.SOLID, color: C.navy, fill: C.navy },
    spacing: { before: 280, after: 120 },
    indent: { left: 120 },
  });
}

function heading2(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 22, color: C.navy, font: 'Calibri' })],
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.gold } },
  });
}

function bodyPara(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({
      text,
      size: 18,
      font: 'Consolas',
      color: opts.color || C.darkText,
      bold: opts.bold || false,
    })],
    spacing: { after: 40 },
    indent: opts.indent ? { left: convertInchesToTwip(0.25) } : undefined,
  });
}

function notePara(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 17, font: 'Calibri', color: '555555', italics: true })],
    spacing: { after: 40 },
    indent: { left: convertInchesToTwip(0.25) },
  });
}

function spacer() {
  return new Paragraph({ children: [new TextRun('')], spacing: { after: 80 } });
}

/** Shared border definition for table cells */
const cellBorders = {
  top:    { style: BorderStyle.SINGLE, size: 4, color: C.midGray },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: C.midGray },
  left:   { style: BorderStyle.SINGLE, size: 4, color: C.midGray },
  right:  { style: BorderStyle.SINGLE, size: 4, color: C.midGray },
};

function makeCell(text, { header = false, align = 'left', bgColor = null, width = null, color = null } = {}) {
  const bg = bgColor || (header ? C.navy : null);
  const textColor = color || (header ? C.white : C.darkText);
  const cell = new TableCell({
    children: [new Paragraph({
      children: [new TextRun({
        text: String(text ?? ''),
        bold: header,
        size: header ? 18 : 18,
        font: 'Calibri',
        color: textColor,
      })],
      alignment: align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { before: 60, after: 60 },
      indent: { left: 80, right: 80 },
    })],
    shading: bg ? { type: ShadingType.SOLID, color: bg, fill: bg } : undefined,
    borders: cellBorders,
    width: width ? { size: width, type: WidthType.DXA } : undefined,
  });
  return cell;
}

function dataTable(headers, rows, colWidths = null) {
  const headerRow = new TableRow({
    children: headers.map((h, i) =>
      makeCell(h, { header: true, width: colWidths ? colWidths[i] : null })
    ),
    tableHeader: true,
  });
  const dataRows = rows.map((row, ri) => new TableRow({
    children: row.map((cell, ci) => {
      const isUsd  = typeof cell === 'string' && cell.startsWith('$');
      const isNeg  = isUsd && cell.startsWith('$-');
      const isPos  = isUsd && !isNeg && cell !== '$0.00' && cell !== 'n/a';
      let bg = ri % 2 === 0 ? null : C.lightGray;
      let color = null;
      if (isNeg && ci > 0) { bg = C.redBg;  color = C.red;   }
      if (isPos && ci > 0) { /* no special highlight */ }
      return makeCell(cell, {
        align: ci > 0 ? 'right' : 'left',
        bgColor: bg,
        color,
        width: colWidths ? colWidths[ci] : null,
      });
    }),
  }));
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

// ── build document sections ───────────────────────────────────────────────────

const children = [];

// Cover / title
children.push(
  new Paragraph({
    children: [new TextRun({ text: 'BTC FULL REPORT', bold: true, size: 52, color: C.white, font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    shading: { type: ShadingType.SOLID, color: C.navy, fill: C.navy },
    spacing: { before: 400, after: 0 },
    indent: { left: 0 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Pair 20 — BTC_Options_Hedge  (Deribit-H4)', bold: true, size: 28, color: C.gold, font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    shading: { type: ShadingType.SOLID, color: C.navy, fill: C.navy },
    spacing: { before: 0, after: 0 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Generated (UTC): 2026-04-16T06:26:43.953Z', size: 20, color: 'AAAAAA', font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    shading: { type: ShadingType.SOLID, color: C.navy, fill: C.navy },
    spacing: { before: 40, after: 400 },
  }),
  spacer(),
);

// ── SECTION 1: Adapt count ────────────────────────────────────────────────────
children.push(
  heading1('SECTION 1 · ADAPTIVE LEVEL CHANGES'),
  heading2('Source: DB · SpreadLevelHistory  (changedBy = "adapt")'),
);
children.push(
  dataTable(
    ['Field', 'Value'],
    [
      ['Pair ID', '20'],
      ['Times levels adapted (all-time)', '19'],
      ['Last adapt (UTC)', 'Thu Apr 16 2026  06:05:13 UTC'],
      ['Last adapt levels ($)', '[156.37, 159.25, 162.12, 164.99, 167.87]'],
      ['Last adapt TP / SL / Cap', 'tp = 11.5018  |  sl = 21.47  |  cap = 171.71'],
    ],
    [3200, 6000]
  ),
  spacer(),
  notePara('Spread-level detail rows are excluded per request — adapt count only is shown above.'),
  spacer(),
);

// ── SECTION 2: Balance ────────────────────────────────────────────────────────
children.push(
  heading1('SECTION 2 · BALANCE'),
  heading2('Source: Exchange · private/get_account_summary  (live)'),
  bodyPara('BTC index price (reference): $75,073.13', { bold: true }),
  spacer(),
  dataTable(
    ['Metric', 'BTC', '~USD'],
    [
      ['Equity (incl. unrealized PnL)',             '1.39336241 BTC', '$104,604.08'],
      ['Balance (wallet, no UPL)',                  '1.10835735 BTC',  '$83,207.86'],
      ['Available funds',                           '0.92115845 BTC',  '$69,154.25'],
      ['Session UPL (unrealized, Deribit session)', '0.01477718 BTC',   '$1,109.37'],
      ['Session RPL (realized, Deribit session)',  '-0.00042087 BTC',     '$-31.60'],
      ['Session total PnL (UPL + RPL)',             '0.01435631 BTC',   '$1,077.77'],
      ['Bot start balance (config snapshot)',        '1.10779768 BTC',  '$83,165.84'],
      ['Equity at bot start (config snapshot)',          '~1.377 BTC', '~$101,727'],
    ],
    [4600, 2600, 2600]
  ),
  spacer(),
);

// ── SECTION 3: Positions ──────────────────────────────────────────────────────
children.push(
  heading1('SECTION 3 · POSITIONS'),
  heading2('Source: Exchange · get_positions  (futures + options)'),
  bodyPara('Total position rows: 5   |   Open (non-zero size): 3   |   Open orders: 0'),
  spacer(),
  dataTable(
    ['Instrument', 'Size', 'Direction', 'Avg Price', 'Unrealized PnL (~$)', 'Delta', 'Kind'],
    [
      ['BTC-PERPETUAL',       '8,600',   'BUY',  '$75,106.02',    '$-2.10',   '0.114533', 'Future'],
      ['BTC-24APR26-73000-C',    '-6',  'SELL',      '0.0345', '$-3,494.81', '-4.089690', 'Option'],
      ['BTC-29MAY26-74000-C',    '+8',   'BUY',       '0.060',  '$4,891.26',  '4.591820', 'Option'],
    ],
    [2800, 900, 1100, 1400, 1900, 1400, 1000]
  ),
  spacer(),
);

// ── SECTION 4: Volume ────────────────────────────────────────────────────────
children.push(
  heading1('SECTION 4 · VOLUME'),
  heading2('Source: Exchange · get_user_trades_by_currency_and_time  (since bot start)'),
  bodyPara('Window: since bot start  2026-04-15T14:35:00Z  →  2026-04-16T06:26:38Z'),
  spacer(),
  dataTable(
    ['Metric', 'Value'],
    [
      ['Executed instrument',                   'BTC-PERPETUAL'],
      ['Total fills (BTC-PERPETUAL)',                     '367'],
      ['Volume BTC-PERPETUAL  Σ|amount| USD',    '$512,600.00'],
      ['Total fills (ALL instruments)',                   '367'],
      ['Volume ALL instruments  Σ|amount| USD',  '$512,600.00'],
    ],
    [4600, 4600]
  ),
  spacer(),
);

// ── SECTION 5: Profit / Loss Exits ───────────────────────────────────────────
children.push(
  heading1('SECTION 5 · PROFIT & LOSS EXITS'),
  heading2('Source: Exchange fills on BTC-PERPETUAL  (profit_loss field)'),
  notePara('"Exit fill" = exchange fill where profit_loss ≠ 0  (exchange books realized PnL on each size reduction)'),
  spacer(),
  dataTable(
    ['Metric', 'Count'],
    [
      ['Total closing fills  (profit_loss ≠ 0)',  '175'],
      ['Total PROFIT exits   (profit_loss > 0)',   '99'],
      ['Total LOSS exits     (profit_loss < 0)',   '76'],
      ['Open fills           (profit_loss = 0)',  '192'],
    ],
    [6200, 2000]
  ),
  spacer(),
);

// ── SECTION 6: PNL on profit exits ───────────────────────────────────────────
children.push(
  heading1('SECTION 6 · PNL REALISED ON PROFIT EXITS'),
  heading2('Rule: profit_loss + maker_rebate  —  taker fee NOT deducted for market-close fills'),
  spacer(),
  dataTable(
    ['Metric', 'BTC', '~USD'],
    [
      ['Sum profit_loss on profit exits (price PnL)',           '0.00176492',  '$132.50'],
      ['Maker rebates on profit-exit fills (+)',                '0.00022801',   '$17.12'],
      ['PNL on profit exits  (pl + rebate, excl. mkt taker)',   '0.00153691',  '$115.38'],
      ['Sum profit_loss on LOSS exits',                        '-0.00124817',  '$-93.70'],
    ],
    [4800, 2200, 2200]
  ),
  spacer(),
  notePara('Market-close taker fees are excluded from profit-exit economic PnL per request.'),
  spacer(),
);

// ── SECTION 7: Rebates ───────────────────────────────────────────────────────
children.push(
  heading1('SECTION 7 · REBATES'),
  heading2('Source: Exchange fills — maker rebates credited to wallet  (BTC-PERPETUAL)'),
  spacer(),
  dataTable(
    ['Metric', 'BTC', '~USD'],
    [
      ['Total maker rebates  (fee < 0 fills, Σ|fee|)', '0.00068248',  '$51.24'],
      ['Total taker paid     (fee > 0 fills)',          '0.00001256',   '$0.94'],
      ['Net fee  (taker − rebate)',                    '-0.00066992', '$-50.29'],
    ],
    [4800, 2200, 2200]
  ),
  spacer(),
);

// ── SECTION 8: Overall PnL summary ───────────────────────────────────────────
children.push(
  heading1('SECTION 8 · OVERALL PNL SUMMARY'),
  heading2('Source: Exchange fills on BTC-PERPETUAL  (all fills in window)'),
  spacer(),
  dataTable(
    ['Metric', 'BTC', '~USD'],
    [
      ['Sum profit_loss  (price-only realized PnL)',     '0.00051675',  '$38.79'],
      ['mark PnL − (−rebate) = pl + rebate+',            '0.00119923',  '$90.03'],
      ['Wallet on fills  (Σ profit_loss + Σ fee)',       '-0.00015317', '$-11.50'],
    ],
    [4800, 2200, 2200]
  ),
  spacer(),
);

// ── NOTES ────────────────────────────────────────────────────────────────────
children.push(
  heading1('NOTES'),
  notePara('• SpreadLevelHistory adapt count is from DB only — exchange does not store this.'),
  notePara('• Balance, positions, and fills are fetched live from Deribit exchange at report time.'),
  notePara('• BTC index price used for USD conversions: $75,073.13'),
  notePara('• "Profit exit" = exchange fill where profit_loss > 0 (per-fill, not a strategy round-trip).'),
  notePara('• "Taker not deducted for market close": market-order fills on profit exits have taker fee'),
  notePara('  excluded from economic PnL  (economic PnL = profit_loss + maker_rebate only).'),
  notePara('• Volume = Σ|amount| in USD (Deribit inverse contracts denominate amount in USD).'),
  spacer(),
);

// ── Pack & write ──────────────────────────────────────────────────────────────
const doc = new Document({
  creator: 'BTC Bot Report',
  title:   'BTC Full Report — Pair 20',
  description: 'BTC_Options_Hedge automated trading report',
  sections: [{
    properties: {
      page: {
        margin: {
          top:    convertInchesToTwip(0.9),
          bottom: convertInchesToTwip(0.9),
          left:   convertInchesToTwip(0.85),
          right:  convertInchesToTwip(0.85),
        },
      },
    },
    children,
  }],
});

const ts      = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(REPORTS_DIR, `btc_full_report_pair20_${ts}.docx`);

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outPath, buf);
  console.log('Wrote', outPath);
});
