// Unit-test the PULSE dark-mode colour helpers exactly as they ship inside
// the patched @fortune-sheet/core bundle (extracted verbatim from the dist).
const fs = require('fs');
const src = fs.readFileSync('node_modules/@fortune-sheet/core/dist/index.js', 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const dark = extract('__pulseFortuneDark');
const rgb = extract('__pulseFortuneRgb');
const isGrey = extract('__pulseFortuneIsGrey');
const paper = extract('__pulseFortunePaperFill');
const ink = extract('__pulseFortuneDarkInk');
const borderInk = extract('__pulseFortuneBorderInk');
const theme = extract('__pulseFortuneTheme');

// simulate dark mode
globalThis.document = { documentElement: { classList: { contains: (c) => c === 'dark' } } };
const fns = new Function(`${dark}${theme}${rgb}${isGrey}${paper}${ink}${borderInk}
  return { isDark: __pulseFortuneDark, theme: __pulseFortuneTheme, paper: __pulseFortunePaperFill, ink: __pulseFortuneDarkInk, border: __pulseFortuneBorderInk };`)();

let fails = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${label}`);
}

// dark mode on
eq(fns.isDark(), true, 'dark detected');
eq(fns.paper('#ffffff'), true, 'pure white fill -> paper');
eq(fns.paper('#FFFFFF'), true, 'uppercase white -> paper');
eq(fns.paper('#fff'), true, 'short white -> paper');
eq(fns.paper('#f2f2f2'), true, 'excel bg1-5% -> paper');
eq(fns.paper('#e7e6e6'), true, 'excel bg1-10% -> paper');
eq(fns.paper('#fafafa'), true, 'near white -> paper');
eq(fns.paper('#d9d9d9'), false, 'excel bg1-15% keeps its grey chip');
eq(fns.paper('#ffff00'), false, 'yellow fill wins (not grey)');
eq(fns.paper('#7c3aed'), false, 'brand purple fill wins');
eq(fns.paper('rgb(255,255,255)'), true, 'rgb() white -> paper');
eq(fns.paper(undefined), false, 'no fill -> handled by !fillStyle branch');
eq(fns.paper(null), false, 'null fill safe');
eq(fns.paper(''), false, 'empty fill safe');

eq(fns.ink('#000000'), true, 'black text -> dark ink');
eq(fns.ink('#111111'), true, '#111 -> dark ink');
eq(fns.ink('#333333'), true, '#333 -> dark ink');
eq(fns.ink('#404040'), true, '#404040 -> dark ink');
eq(fns.ink('#555555'), false, 'mid grey text keeps its colour');
eq(fns.ink('#ff0000'), false, 'red text keeps its colour');
eq(fns.ink('#1f4e79'), false, 'excel dark blue text keeps its colour');

eq(fns.border('#000000'), '#f2f2f7', 'black border renders white in dark');
eq(fns.border('#333333'), '#f2f2f7', '#333 border renders white in dark');
eq(fns.border('#ff0000'), '#ff0000', 'red border keeps its colour');
eq(fns.border('#ffffff'), '#ffffff', 'white border stays white (visible on dark)');
eq(fns.theme('#FFFFFF', '#13131c'), '#13131c', 'theme picks dark value');

// light mode: everything passes through untouched
globalThis.__PULSE_FORTUNE_LIGHT__ = true;
eq(fns.isDark(), false, 'print escape hatch disables dark');
eq(fns.paper('#ffffff'), false, 'light mode: white fill stays a fill');
eq(fns.ink('#000000'), false, 'light mode: black text stays black');
eq(fns.border('#000000'), '#000000', 'light mode: black border stays black');
delete globalThis.__PULSE_FORTUNE_LIGHT__;
globalThis.document = { documentElement: { classList: { contains: () => false } } };
eq(fns.isDark(), false, 'no .dark class -> light');
eq(fns.paper('#ffffff'), false, 'no dark class: white stays white');

console.log(fails === 0 ? '\nALL HELPER TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
