/**
 * ui/utils/xlsxWriter.js
 * ======================
 * Minimal, dependency-light XLSX writer built on top of JSZip (already a
 * project dependency). Produces a valid .xlsx workbook from in-memory sheets
 * so the browser benchmark can export an Excel file directly — no SheetJS.
 *
 * Each sheet is { name, rows } where rows is a 2D array of cells. A cell is a
 * primitive (string | number | null) or { v, bold, fill } for light styling.
 * Styling support is intentionally small: bold + solid background fill.
 */

import JSZip from 'jszip';

function colName(idx) {
  // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  idx += 1;
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Build the styles.xml with a small palette of fills + a bold font.
 * Style indices:
 *   0 = default
 *   1 = bold
 *   2..n = bold + fill[color]
 */
function buildStyles(fillColors) {
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  fillColors.forEach((c) => {
    fills.push(
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`
    );
  });

  // cellXfs: 0 default, 1 bold, then bold+fill for each color
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  ];
  fillColors.forEach((_, i) => {
    xfs.push(
      `<xf numFmtId="0" fontId="1" fillId="${i + 2}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`
    );
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function cellStyleIndex(cell, fillColors) {
  if (cell == null || typeof cell !== 'object') return 0;
  if (cell.fill) {
    let idx = fillColors.indexOf(cell.fill);
    if (idx === -1) { fillColors.push(cell.fill); idx = fillColors.length - 1; }
    return idx + 2;
  }
  if (cell.bold) return 1;
  return 0;
}

function buildSheet(rows, fillColors) {
  const lines = [];
  rows.forEach((row, r) => {
    const cells = [];
    (row || []).forEach((cell, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const raw = cell != null && typeof cell === 'object' ? cell.v : cell;
      const style = cellStyleIndex(cell, fillColors);
      const sAttr = style ? ` s="${style}"` : '';
      if (raw == null || raw === '') {
        if (style) cells.push(`<c r="${ref}"${sAttr}/>`);
        return;
      }
      if (isNumber(raw)) {
        cells.push(`<c r="${ref}"${sAttr}><v>${raw}</v></c>`);
      } else {
        cells.push(`<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(raw)}</t></is></c>`);
      }
    });
    lines.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${lines.join('')}</sheetData>
</worksheet>`;
}

/**
 * @param {Array<{name:string, rows:Array<Array<any>>}>} sheets
 * @returns {Promise<Blob>} xlsx blob
 */
export async function buildXlsxBlob(sheets) {
  const zip = new JSZip();
  const fillColors = []; // discovered while building sheets

  // Pre-scan cells to register fill colors before styles.xml is written.
  for (const sheet of sheets) {
    for (const row of sheet.rows || []) {
      for (const cell of row || []) {
        if (cell && typeof cell === 'object' && cell.fill && !fillColors.includes(cell.fill)) {
          fillColors.push(cell.fill);
        }
      }
    }
  }

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  const sheetEntries = sheets.map((s, i) =>
    `<sheet name="${escapeXml(s.name || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetEntries}</sheets>
</workbook>`);

  const relEntries = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const stylesRelId = sheets.length + 1;
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relEntries}
<Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  zip.file('xl/styles.xml', buildStyles(fillColors));

  sheets.forEach((s, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, buildSheet(s.rows || [], fillColors));
  });

  return zip.generateAsync({ type: 'blob', mimeType:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export default { buildXlsxBlob };
