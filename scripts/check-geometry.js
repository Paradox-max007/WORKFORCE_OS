(() => {
  const npc = [...document.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent.includes('NPC'));
  if (!npc) return 'NPC section not found';
  const table = npc.querySelector('table');
  const headerCells = [...table.querySelectorAll('thead th')];
  const rows = [...npc.querySelectorAll('tbody tr')];
  const arunRow = rows.find((r) => r.textContent.includes('Arun Nair'));
  const normalRow = rows.find((r) => r.textContent.includes('Kamal Hussain'));

  // column counts
  const normalTds = normalRow.querySelectorAll('td').length;
  const arunTds = arunRow.querySelectorAll('td').length;
  const arunCols = [...arunRow.querySelectorAll('td')].reduce((n, td) => n + (td.colSpan || 1), 0);
  const headerCount = headerCells.length;

  // locate the merged td and the header for day 30 / day 31
  const mergedTd = arunRow.querySelector('td[colspan]');
  const mergedIdx = [...arunRow.children].indexOf(mergedTd);
  const mergedRect = mergedTd.getBoundingClientRect();
  const th30 = headerCells.find((th) => th.querySelector('div')?.textContent === '30');
  const th31 = headerCells.find((th) => th.querySelector('div')?.textContent === '31');
  const thTotal = headerCells.find((th) => th.textContent.includes('Total'));
  const r30 = th30.getBoundingClientRect();
  const r31 = th31.getBoundingClientRect();
  const rTotal = thTotal.getBoundingClientRect();

  // editable inputs in Arun's row (should be days 1..29 only = 29 inputs)
  const arunInputs = arunRow.querySelectorAll('input').length;
  const normalInputs = normalRow.querySelectorAll('input').length;

  return JSON.stringify({
    headerCount,
    normalTds,
    arunTds,
    arunCols,
    mergedIdx,
    mergedLabel: mergedTd.textContent.trim(),
    mergedLeftVsDay30: Math.round(mergedRect.left - r30.left),
    mergedRightVsDay31: Math.round(mergedRect.right - r31.right),
    mergedRightVsTotalGap: Math.round(rTotal.left - mergedRect.right),
    arunInputs,
    normalInputs,
    arunRowIsLast: rows[rows.length - 1] === arunRow,
    arunTotals: [...arunRow.querySelectorAll('td')].slice(-2).map((td) => td.textContent.trim()),
  }, null, 1);
})()
