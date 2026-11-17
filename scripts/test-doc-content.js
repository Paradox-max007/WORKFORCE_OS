// Standalone test of the doc-content extraction logic (spreadsheet + pdf)
// against the sample files — mirrors src/lib/files/doc-content.ts exactly.
const fs = require('fs');

const MAX_CHARS = 9000, MAX_SHEETS = 6, MAX_ROWS = 300, MAX_PAGES = 12;

function clip(t) {
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + '\n…[truncated]' : t;
}

async function extractSpreadsheet(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const parts = [];
  for (const name of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false, defval: '' });
    const lines = [];
    for (const row of rows) {
      if (lines.length >= MAX_ROWS) { lines.push('…[truncated]'); break; }
      const cells = (Array.isArray(row) ? row : [row]).map((c) => String(c ?? '').trim()).filter(Boolean);
      if (cells.length > 0) lines.push(cells.join(' | '));
    }
    if (lines.length > 0) parts.push(`— sheet "${name}" —\n${lines.join('\n')}`);
  }
  if (parts.length === 0) return '(no readable text content)';
  return clip(parts.join('\n\n'));
}

async function extractPdf(buf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_PAGES);
  const parts = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = [];
    let line = '';
    for (const item of tc.items) {
      if (typeof item.str !== 'string') continue;
      line += item.str;
      if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
    }
    if (line.trim()) lines.push(line.trim());
    if (lines.length > 0) parts.push(pdf.numPages > 1 ? `— page ${p} —\n${lines.join('\n')}` : lines.join('\n'));
  }
  if (parts.length === 0) return '(no text layer — scan?)';
  return clip(parts.join('\n\n'));
}

(async () => {
  // 1) the sample timesheet workbook
  const xlsxText = await extractSpreadsheet(fs.readFileSync('download/timesheet-sample-edited.xlsx'));
  console.log('=== XLSX ===');
  console.log(xlsxText.slice(0, 1200));
  console.log(`(${xlsxText.length} chars)\n`);

  // 2) a generated PDF with a text layer
  const { execSync } = require('child_process');
  execSync(`python3 -c "
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
c = canvas.Canvas('/tmp/pebby-test.pdf', pagesize=A4)
c.drawString(72, 780, 'MARINA TOWER - TIME CARD NOVEMBER 2026')
c.drawString(72, 760, 'EMPLOYEE: ARUN KUMAR (PUL-2026-001)')
c.drawString(72, 740, 'TOTAL HOURS: 208.5')
c.showPage()
c.drawString(72, 780, 'PAGE 2 - REMARKS')
c.drawString(72, 760, 'Overtime approved by site supervisor.')
c.save()
"`);
  const pdfText = await extractPdf(fs.readFileSync('/tmp/pebby-test.pdf'));
  console.log('=== PDF ===');
  console.log(pdfText);
  console.log(`(${pdfText.length} chars)`);

  const okX = /sheet/.test(xlsxText) && xlsxText.length > 50;
  const okP = pdfText.includes('MARINA TOWER') && pdfText.includes('PAGE 2');
  console.log(`\n${okX && okP ? 'EXTRACTION TESTS PASSED' : 'EXTRACTION TESTS FAILED'}`);
  process.exit(okX && okP ? 0 : 1);
})();
