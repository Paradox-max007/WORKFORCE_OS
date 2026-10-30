(() => {
  const page = document.querySelector('.att-page');
  if (!page) return 'attendance sheet page not found';
  const rows = [...page.querySelectorAll('.att-table tbody tr')];
  const names = [];
  for (const tr of rows) {
    const nameTd = tr.children[1];
    const input = nameTd?.querySelector('input');
    const val = input ? input.value : (nameTd?.textContent ?? '').trim();
    if (val && val !== '\u00A0') names.push(val);
  }
  return JSON.stringify({ rowCount: rows.length, names, hasArun: names.some((r) => r.includes('ARUN')) });
})()
