// Logic test for src/lib/site-timeline.ts — the 14 spec scenarios that can be
// verified without a browser. Run: bun tests/site-timeline.test.ts
import {
  addDaysYMD,
  buildMonthTimeline,
  getEmployeeSiteForDate,
  indexRecords,
  transferDisplayDate,
} from '../src/lib/site-timeline';
import type { Attendance, SiteTransfer } from '../src/lib/types';

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const SITE_A = 'site-a', SITE_B = 'site-b', SITE_C = 'site-c';
const EMP = 'emp-1';

// created_at timestamps — "25th marked at 17:00, moved at 20:00"
const T_MARK_25 = '2026-03-25T17:00:00.000Z';   // attendance marked on the 25th
const T_MOVE_25 = '2026-03-25T20:00:00.000Z';   // move recorded on the 25th at 8 PM
const T_MOVE_26 = '2026-03-26T09:00:00.000Z';

const tr = (from: string | null, to: string | null, eff: string, at: string): SiteTransfer => ({
  id: `t-${at}`, employee_id: EMP, from_site_id: from, to_site_id: to,
  effective_date: eff, created_at: at,
});
const att = (date: string, at: string, hours = 8): Attendance => ({
  id: `a-${date}-${at}`, employee_id: EMP, date, status: 'present',
  hours, is_hidden: false, created_at: at,
});

console.log('— Scenario 1: 25th transfer, NO attendance on the 25th → Site B owns the 25th');
{
  const transfers = [tr(SITE_A, SITE_B, '2026-03-25', T_MOVE_25)];
  const s = getEmployeeSiteForDate(EMP, '2026-03-24', { transfers, records: [], currentSiteId: SITE_B });
  const s25 = getEmployeeSiteForDate(EMP, '2026-03-25', { transfers, records: [], currentSiteId: SITE_B });
  check('24th → Site A', s === SITE_A);
  check('25th → Site B (display_from_date = effective_date)', s25 === SITE_B);
}

console.log('— Scenario 2: 25th marked 17:00 + moved 20:00 → move displays from the 26th');
{
  const records = [att('2026-03-25', T_MARK_25)];
  const transfers = [tr(SITE_A, SITE_B, '2026-03-25', T_MOVE_25)];
  const input = { transfers, records, currentSiteId: SITE_B };
  const d = transferDisplayDate(transfers[0], indexRecords(records).get(EMP), '2026-03-31');
  check('display date = 26th', d === '2026-03-26', `got ${d}`);
  check('25th → Site A (marked before the move)', getEmployeeSiteForDate(EMP, '2026-03-25', input) === SITE_A);
  check('26th → Site B', getEmployeeSiteForDate(EMP, '2026-03-26', input) === SITE_B);
  const tl = buildMonthTimeline(EMP, 2026, 3, input);
  check('timeline: 2 segments split at day 26',
    tl.segments.length === 2 && tl.segments[0].siteId === SITE_A && tl.segments[0].toDay === 25
    && tl.segments[1].siteId === SITE_B && tl.segments[1].fromDay === 26,
    JSON.stringify(tl.segments));
}

console.log('— Scenario 3: attendance marked AFTER the move (21:00) → the 25th still belongs to Site B');
{
  const records = [att('2026-03-25', '2026-03-25T21:00:00.000Z')];
  const input = { transfers: [tr(SITE_A, SITE_B, '2026-03-25', T_MOVE_25)], records, currentSiteId: SITE_B };
  check('25th → Site B', getEmployeeSiteForDate(EMP, '2026-03-25', input) === SITE_B);
}

console.log('— Scenario 4: A → B → C in one month (10th and 20th)');
{
  const transfers = [
    tr(SITE_A, SITE_B, '2026-03-10', '2026-03-10T08:00:00.000Z'),
    tr(SITE_B, SITE_C, '2026-03-20', '2026-03-20T08:00:00.000Z'),
  ];
  const input = { transfers, records: [], currentSiteId: SITE_C };
  check('1st → A', getEmployeeSiteForDate(EMP, '2026-03-01', input) === SITE_A);
  check('10th → B', getEmployeeSiteForDate(EMP, '2026-03-10', input) === SITE_B);
  check('19th → B', getEmployeeSiteForDate(EMP, '2026-03-19', input) === SITE_B);
  check('20th → C', getEmployeeSiteForDate(EMP, '2026-03-20', input) === SITE_C);
  check('31st → C', getEmployeeSiteForDate(EMP, '2026-03-31', input) === SITE_C);
  const tl = buildMonthTimeline(EMP, 2026, 3, input);
  check('3 segments 1-9/10-19/20-31',
    tl.segments.length === 3 && tl.segments[0].siteId === SITE_A && tl.segments[0].toDay === 9
    && tl.segments[1].siteId === SITE_B && tl.segments[1].fromDay === 10 && tl.segments[1].toDay === 19
    && tl.segments[2].siteId === SITE_C && tl.segments[2].fromDay === 20,
    JSON.stringify(tl.segments));
}

console.log('— Scenario 5: transfer in a PREVIOUS month → history month shows a single old-site row');
{
  const transfers = [tr(SITE_A, SITE_B, '2026-02-15', '2026-02-15T08:00:00.000Z')];
  const input = { transfers, records: [], currentSiteId: SITE_B };
  const jan = buildMonthTimeline(EMP, 2026, 1, input);
  check('January → single Site A segment, not transferred',
    jan.segments.length === 1 && jan.segments[0].siteId === SITE_A && !jan.transferred);
  const mar = buildMonthTimeline(EMP, 2026, 3, input);
  check('March → single Site B segment, not transferred',
    mar.segments.length === 1 && mar.segments[0].siteId === SITE_B && !mar.transferred);
}

console.log('— Scenario 6: FUTURE transfer (next month) → current month unaffected');
{
  const transfers = [tr(SITE_A, SITE_B, '2026-04-05', '2026-03-28T08:00:00.000Z')];
  const input = { transfers, records: [], currentSiteId: SITE_A };
  check('31st March → Site A', getEmployeeSiteForDate(EMP, '2026-03-31', input) === SITE_A);
  const tl = buildMonthTimeline(EMP, 2026, 3, input);
  check('March timeline: single Site A segment', tl.segments.length === 1 && tl.segments[0].siteId === SITE_A && !tl.transferred);
}

console.log('— Scenario 7: idle segments (site → null → site)');
{
  const transfers = [
    tr(SITE_A, null, '2026-03-08', '2026-03-08T08:00:00.000Z'),
    tr(null, SITE_B, '2026-03-18', '2026-03-18T08:00:00.000Z'),
  ];
  const input = { transfers, records: [], currentSiteId: SITE_B };
  check('7th → A', getEmployeeSiteForDate(EMP, '2026-03-07', input) === SITE_A);
  check('12th → null (idle)', getEmployeeSiteForDate(EMP, '2026-03-12', input) === null);
  check('19th → B', getEmployeeSiteForDate(EMP, '2026-03-19', input) === SITE_B);
  const tl = buildMonthTimeline(EMP, 2026, 3, input);
  check('3 segments incl. null middle',
    tl.segments.length === 3 && tl.segments[1].siteId === null && tl.segments[1].fromDay === 8 && tl.segments[1].toDay === 17,
    JSON.stringify(tl.segments));
}

console.log('— Scenario 8: two transfers on the SAME date → deterministic created_at order');
{
  const transfers = [
    tr(SITE_B, SITE_C, '2026-03-25', '2026-03-25T20:00:00.000Z'), // later record
    tr(SITE_A, SITE_B, '2026-03-25', '2026-03-25T10:00:00.000Z'), // earlier record
  ];
  const input = { transfers, records: [], currentSiteId: SITE_C };
  check('24th → Site A', getEmployeeSiteForDate(EMP, '2026-03-24', input) === SITE_A);
  check('25th → Site C (fold applies both, later wins)', getEmployeeSiteForDate(EMP, '2026-03-25', input) === SITE_C);
}

console.log('— Scenario 9: consecutive pre-marked days walk past them all (24th+25th marked, move on 25th)');
{
  const records = [att('2026-03-24', '2026-03-24T09:00:00.000Z'), att('2026-03-25', T_MARK_25)];
  const transfers = [tr(SITE_A, SITE_B, '2026-03-25', T_MOVE_25)];
  const input = { transfers, records, currentSiteId: SITE_B };
  const d = transferDisplayDate(transfers[0], indexRecords(records).get(EMP), '2026-03-31');
  check('display date = 26th (walk stops at first unmarked day)', d === '2026-03-26', `got ${d}`);
  check('24th → Site A', getEmployeeSiteForDate(EMP, '2026-03-24', input) === SITE_A);
  check('25th → Site A', getEmployeeSiteForDate(EMP, '2026-03-25', input) === SITE_A);
  check('26th → Site B', getEmployeeSiteForDate(EMP, '2026-03-26', input) === SITE_B);
}

console.log('— Scenario 10: addDaysYMD across month/year boundary');
{
  check('2026-03-31 +1 = 2026-04-01', addDaysYMD('2026-03-31', 1) === '2026-04-01');
  check('2026-12-31 +1 = 2027-01-01', addDaysYMD('2026-12-31', 1) === '2027-01-01');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
