// Logic tests for the shared date-effective site-assignment engine
// (src/lib/site-timeline.ts) — covers the mandatory transfer scenarios.
// Run: bun run scripts/test-site-timeline.ts

import {
  buildMonthTimeline,
  getEmployeeSiteForDate,
  indexRecords,
  transferDisplayDate,
  type SiteTimelineInput,
} from '../src/lib/site-timeline';
import type { Attendance, SiteTransfer } from '../src/lib/types';

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ✔ ${label}`); }
  else { failed++; console.error(`  ✘ ${label}\n      expected ${e}\n      actual   ${a}`); }
}

const SITE_A = 'site-a';
const SITE_B = 'site-b';
const SITE_C = 'site-c';
const EMP = 'emp-1';

const tr = (id: string, from: string | null, to: string | null, effective: string, created: string): SiteTransfer =>
  ({ id, employee_id: EMP, from_site_id: from, to_site_id: to, effective_date: effective, created_at: created });

const rec = (date: string, created: string): Attendance =>
  ({ id: `r-${date}`, employee_id: EMP, date, status: 'present', hours: 8, is_hidden: false, created_at: created });

const input = (transfers: SiteTransfer[], records: Attendance[] = [], current: string | null = SITE_A): SiteTimelineInput =>
  ({ transfers, records, currentSiteId: current });

console.log('\nScenario 1 — move on the 25th, nothing marked on the 25th → B starts on the 25th');
{
  const transfers = [tr('t1', SITE_A, SITE_B, '2026-10-25', '2026-10-25T20:00:00.000Z')];
  const tl = buildMonthTimeline(EMP, 2026, 10, input(transfers));
  check('display date of the move', transferDisplayDate(transfers[0], indexRecords([]).get(EMP), '2026-10-31'), '2026-10-25');
  check('site on the 24th', getEmployeeSiteForDate(EMP, '2026-10-24', input(transfers)), SITE_A);
  check('site on the 25th', getEmployeeSiteForDate(EMP, '2026-10-25', input(transfers)), SITE_B);
  check('month segments', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 24, SITE_A], [25, 31, SITE_B]]);
  check('transferred flag', tl.transferred, true);
}

console.log('\nScenario 2/3 — marked on the 25th at 5 PM, moved on the 25th at 8 PM → B starts on the 26th');
{
  const transfers = [tr('t1', SITE_A, SITE_B, '2026-10-25', '2026-10-25T20:00:00.000Z')];
  const records = [rec('2026-10-25', '2026-10-25T17:00:00.000Z')];
  const inp = input(transfers, records);
  check('the 25th stays Site A', getEmployeeSiteForDate(EMP, '2026-10-25', inp), SITE_A);
  check('the 26th belongs to Site B', getEmployeeSiteForDate(EMP, '2026-10-26', inp), SITE_B);
  const tl = buildMonthTimeline(EMP, 2026, 10, inp);
  check('segments', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 25, SITE_A], [26, 31, SITE_B]]);
}

console.log('\nScenario 4 — mark the 26th AFTER the move → belongs to Site B');
{
  const transfers = [tr('t1', SITE_A, SITE_B, '2026-10-25', '2026-10-25T20:00:00.000Z')];
  const records = [rec('2026-10-25', '2026-10-25T17:00:00.000Z'), rec('2026-10-26', '2026-10-26T09:00:00.000Z')];
  const inp = input(transfers, records);
  check('site on the 26th', getEmployeeSiteForDate(EMP, '2026-10-26', inp), SITE_B);
  check('site on the 25th (history intact)', getEmployeeSiteForDate(EMP, '2026-10-25', inp), SITE_A);
}

console.log('\nScenario 5 — A → B → C inside one month (11th and 21st)');
{
  const transfers = [
    tr('t1', SITE_A, SITE_B, '2026-10-11', '2026-10-11T12:00:00.000Z'),
    tr('t2', SITE_B, SITE_C, '2026-10-21', '2026-10-21T12:00:00.000Z'),
  ];
  const inp = input(transfers);
  check('10th → A', getEmployeeSiteForDate(EMP, '2026-10-10', inp), SITE_A);
  check('11th → B', getEmployeeSiteForDate(EMP, '2026-10-11', inp), SITE_B);
  check('20th → B', getEmployeeSiteForDate(EMP, '2026-10-20', inp), SITE_B);
  check('21st → C', getEmployeeSiteForDate(EMP, '2026-10-21', inp), SITE_C);
  check('31st → C', getEmployeeSiteForDate(EMP, '2026-10-31', inp), SITE_C);
  const tl = buildMonthTimeline(EMP, 2026, 10, inp);
  check('three segments', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]),
    [[1, 10, SITE_A], [11, 20, SITE_B], [21, 31, SITE_C]]);
  check('home site', tl.homeSiteId, SITE_A);
}

console.log('\nScenario 6 — move happened LAST month → normal single segment under the new site');
{
  const transfers = [tr('t1', SITE_A, SITE_B, '2026-09-15', '2026-09-15T10:00:00.000Z')];
  const tl = buildMonthTimeline(EMP, 2026, 10, input(transfers));
  check('October segments', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 31, SITE_B]]);
  check('transferred flag (October view)', tl.transferred, false);
  check('September still shows the split', buildMonthTimeline(EMP, 2026, 9, input(transfers))
    .segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 14, SITE_A], [15, 30, SITE_B]]);
}

console.log('\nScenario 7 — move effective NEXT month → current month unchanged');
{
  const transfers = [tr('t1', SITE_A, SITE_B, '2026-11-05', '2026-10-30T09:00:00.000Z')];
  const tl = buildMonthTimeline(EMP, 2026, 10, input(transfers));
  check('October stays all Site A', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 31, SITE_A]]);
  check('November 5th → B', getEmployeeSiteForDate(EMP, '2026-11-05', input(transfers)), SITE_B);
  check('November 4th → A', getEmployeeSiteForDate(EMP, '2026-11-04', input(transfers)), SITE_A);
}

console.log('\nScenario 10 — transferred to unassigned (idle)');
{
  const transfers = [tr('t1', SITE_A, null, '2026-10-12', '2026-10-12T10:00:00.000Z')];
  const inp = input(transfers);
  check('11th → A', getEmployeeSiteForDate(EMP, '2026-10-11', inp), SITE_A);
  check('12th → idle (null)', getEmployeeSiteForDate(EMP, '2026-10-12', inp), null);
  const tl = buildMonthTimeline(EMP, 2026, 10, inp);
  check('segments incl. idle', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]),
    [[1, 11, SITE_A], [12, 31, null]]);
}

console.log('\nScenario 13/14 — two moves on the SAME date: deterministic, no overlaps');
{
  const transfers = [
    tr('t1', SITE_A, SITE_B, '2026-10-10', '2026-10-10T08:00:00.000Z'),
    tr('t2', SITE_B, SITE_C, '2026-10-10', '2026-10-10T15:00:00.000Z'),
  ];
  const tl = buildMonthTimeline(EMP, 2026, 10, input(transfers));
  check('no overlaps — one segment at C', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]),
    [[1, 9, SITE_A], [10, 31, SITE_C]]);
  const reversed = [transfers[1], transfers[0]]; // order in the array must not matter
  check('array order irrelevant', buildMonthTimeline(EMP, 2026, 10, input(reversed))
    .segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 9, SITE_A], [10, 31, SITE_C]]);

  const atMonthStart = [
    tr('t1', SITE_A, SITE_B, '2026-10-01', '2026-10-01T08:00:00.000Z'),
    tr('t2', SITE_B, SITE_C, '2026-10-01', '2026-10-01T15:00:00.000Z'),
  ];
  check('day-1 double move → single all-month segment', buildMonthTimeline(EMP, 2026, 10, input(atMonthStart))
    .segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 31, SITE_C]]);
}

console.log('\nScenario 2 (edge) — whole month already marked before the move → no visible split');
{
  const transfers = [tr('t1', SITE_A, SITE_B, '2026-10-31', '2026-10-31T20:00:00.000Z')];
  const records = [rec('2026-10-31', '2026-10-31T17:00:00.000Z')];
  const tl = buildMonthTimeline(EMP, 2026, 10, input(transfers, records));
  check('October stays Site A', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 31, SITE_A]]);
  check('November 1st → Site B', getEmployeeSiteForDate(EMP, '2026-11-01', input(transfers, records)), SITE_B);
}

console.log('\nNo transfers at all → current site, no move flags');
{
  const inp = input([], [], SITE_B);
  check('any date → current site', getEmployeeSiteForDate(EMP, '2026-10-15', inp), SITE_B);
  const tl = buildMonthTimeline(EMP, 2026, 10, inp);
  check('segments', tl.segments.map((s) => [s.fromDay, s.toDay, s.siteId]), [[1, 31, SITE_B]]);
  check('transferred', tl.transferred, false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
