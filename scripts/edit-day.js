(() => {
  // find Arun's faded row and its day-20 cell input, set a value, blur it
  const npc = [...document.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent.includes('NPC'));
  const arunRow = [...npc.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('Arun Nair'));
  const inputs = [...arunRow.querySelectorAll('input')];
  const input20 = inputs[19]; // day 20 (first 29 inputs are days 1..29)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input20, '9.5');
  input20.dispatchEvent(new Event('input', { bubbles: true }));
  input20.dispatchEvent(new Event('blur', { bubbles: true }));
  return 'set day20=9.5, inputs=' + inputs.length;
})()
