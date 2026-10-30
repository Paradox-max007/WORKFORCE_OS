(() => {
  const out = [];
  for (const s of document.querySelectorAll('section')) {
    const h = s.querySelector('h3')?.textContent ?? '';
    if (!h) continue;
    const rows = [...s.querySelectorAll('tbody tr')].map((tr) => {
      const name = tr.querySelector('td p')?.textContent ?? '';
      const merged = [...tr.querySelectorAll('td[colspan]')].map(
        (td) => 'colspan=' + td.colSpan + ' [' + td.textContent.trim() + '] title="' + (td.querySelector('div')?.title ?? '') + '"',
      );
      const faded = (tr.getAttribute('class') ?? '').includes('bg-muted/25') ? 'FADED' : '';
      return name + (faded ? ' (FADED)' : '') + (merged.length ? ' MERGED→ ' + merged.join('; ') : '');
    });
    const chip = [...s.querySelectorAll('span')].find((x) => x.textContent.trim().endsWith('moved'))?.textContent ?? '';
    out.push(h + ' → ' + rows.join(' | ') + '   [chip: ' + chip + ']');
  }
  return out.join('\n');
})()
