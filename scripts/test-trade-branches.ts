// Sanity check for BRANCH-OWNED TRADE BOOKS + branch-scoped data (demo engine):
//   1. super admin creates a branch-specific trade — the SAME name may exist
//      in different branches with DIFFERENT rates, never twice in one book
//   2. normal admin (Ravi → Northern Emirates) sees only the shared book +
//      their granted branches' books — another branch's trade never leaks
//   3. normal admins can only create / re-price trades inside their granted
//      branches (the shared All-Branches book is super-admin only)
//   4. a branch-specific trade may only be assigned to an employee working
//      in THAT branch — the books never mix
//   5. getAdvanceBook is branch-scoped for normal admins
// Run: bun run scripts/test-trade-branches.ts

// ---- headless shims: the demo store persists to localStorage ----------------
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
};

const { db, setDemoSessionId } = await import('../src/lib/data/demo-store');
const { demoApi } = await import('../src/lib/data/demo-api');

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures += 1;
};
const expectError = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
    check(name, false, 'no error raised');
  } catch (err) {
    check(name, true, (err as Error).message);
  }
};

const RATES = (base: number) => (['standard', 'team_leader', 'supervisor'] as const).flatMap((role, i) =>
  (['below_threshold', 'qualified'] as const).map((tier) => ({
    salary_role: role,
    experience_tier: tier,
    hourly_rate: base + i + (tier === 'qualified' ? 2 : 0),
  })));

const superP = db.profiles.find((p) => p.email === 'super@pulse.app')!;
const raviP = db.profiles.find((p) => p.email === 'admin@pulse.app')!;
const north = db.branches.find((b) => b.name === 'Northern Emirates Branch')!;
const dubai = db.branches.find((b) => b.name === 'Dubai Central Branch')!;
const npcSite = db.sites.find((s) => s.name.startsWith('NPC'))!;   // Northern Emirates
const redCoast = db.sites.find((s) => s.name.startsWith('Red Coast'))!; // Dubai Central
const marinaSite = db.sites.find((s) => s.name.startsWith('Marina'))!; // Dubai Central (Sara's)

// ---- 1. super admin: same trade name in DIFFERENT books --------------------
setDemoSessionId(superP.id);
const sharedElectrician = db.trades.find((t) => t.name === 'Electrician')!;
check('seeded Electrician is the shared book (branch_id null)', sharedElectrician.branch_id === null);

const dubaiSparky = await demoApi.createTrade({
  name: 'Electrician', description: 'Dubai rates', branch_id: dubai.id,
  is_active: true, rates: RATES(12),
});
check('super admin creates a Dubai-Central Electrician (same name, own book)', dubaiSparky.branch_id === dubai.id);
check('the two Electricians carry DIFFERENT rates',
  (await demoApi.getTradeRateHistory(dubaiSparky.id))[0].hourly_rate
  !== (await demoApi.getTradeRateHistory(sharedElectrician.id))[0].hourly_rate);

await expectError('duplicate name within ONE branch rejected', () =>
  demoApi.createTrade({ name: 'Electrician', description: null, branch_id: dubai.id, is_active: true, rates: RATES(9) }));
await expectError('duplicate name within the SHARED book rejected', () =>
  demoApi.createTrade({ name: 'Electrician', description: null, branch_id: null, is_active: true, rates: RATES(9) }));
const northSparky = await demoApi.createTrade({
  name: 'Electrician', description: 'Northern rates', branch_id: north.id,
  is_active: true, rates: RATES(15),
});
check('same name in a THIRD book is fine', northSparky.branch_id === north.id);

// ---- 2. normal admin scoping (Ravi → Northern Emirates) --------------------
setDemoSessionId(raviP.id);
const raviTrades = await demoApi.listTrades();
check('Ravi sees the shared book', raviTrades.some((t) => t.id === sharedElectrician.id));
check('Ravi sees his branch book (Northern Electrician)', raviTrades.some((t) => t.id === northSparky.id));
check("Ravi does NOT see Dubai's Electrician", !raviTrades.some((t) => t.id === dubaiSparky.id));

// ---- 3. branch-scoped trade management --------------------------------------
await expectError('Ravi cannot create a trade in ANOTHER branch', () =>
  demoApi.createTrade({ name: 'Rigger', description: null, branch_id: dubai.id, is_active: true, rates: RATES(8) }));
await expectError('Ravi cannot create into the shared book', () =>
  demoApi.createTrade({ name: 'Rigger', description: null, branch_id: null, is_active: true, rates: RATES(8) }));
const raviTrade = await demoApi.createTrade({
  name: 'Rigger', description: null, branch_id: north.id, is_active: true, rates: RATES(8),
});
check('Ravi creates a trade inside HIS branch', raviTrade.branch_id === north.id);

await expectError('Ravi cannot re-price the SHARED book', () =>
  demoApi.saveTradeRates(sharedElectrician.id, [{ salary_role: 'standard', experience_tier: 'qualified', hourly_rate: 99 }], '2026-12-01'));
await expectError("Ravi cannot edit ANOTHER branch's trade", () =>
  demoApi.updateTrade(dubaiSparky.id, { name: 'Electrician X', description: null, is_active: true }));
await demoApi.saveTradeRates(northSparky.id, [{ salary_role: 'standard', experience_tier: 'qualified', hourly_rate: 20 }], '2026-12-01');
check('Ravi CAN re-price his own branch trade', true);
await demoApi.updateTrade(northSparky.id, { name: 'Electrician', description: 'Northern rates v2', is_active: true, branch_id: north.id });
check('Ravi CAN edit his own branch trade', true);

// ---- 4. employee trade assignment never mixes books -------------------------
const empInput = (tradeId: string | null, siteId: string | null) => ({
  full_name: 'Test Worker', nationality: 'India', date_of_birth: null, phone: null,
  email: null, address: null, emergency_contact: null, position: null, join_date: '2026-01-01',
  company_name: null, passport_number: null, passport_status: null, id_number: null,
  id_status: null, current_site_id: siteId, camp_id: null, camp_block: null, camp_room: null,
  photo: null, is_team_leader: false, team_leader_site_id: null, trade_id: tradeId,
  salary_role: 'standard' as const,
});

setDemoSessionId(superP.id);
await expectError('Dubai trade on a Northern-Emirates employee rejected', () =>
  demoApi.createEmployee(empInput(dubaiSparky.id, npcSite.id)));
const sharedWorker = await demoApi.createEmployee(empInput(sharedElectrician.id, npcSite.id));
check('shared-book trade fits any employee', sharedWorker.trade_id === sharedElectrician.id);
const branchWorker = await demoApi.createEmployee(empInput(northSparky.id, npcSite.id));
check('own-branch trade fits the branch employee', branchWorker.trade_id === northSparky.id);

// a SITE MOVE never invalidates a stored trade (the payroll keeps pricing
// until the trade itself is changed) — but CHANGING the trade re-validates
const moved = await demoApi.updateEmployee(branchWorker.id, empInput(northSparky.id, redCoast.id));
check('site move keeps the stored (now cross-branch) trade', moved.trade_id === northSparky.id && moved.current_site_id === redCoast.id);
const reTrade = await demoApi.updateEmployee(branchWorker.id, empInput(dubaiSparky.id, redCoast.id));
check('changing to the SITE branch book trade is allowed (Dubai trade + Dubai site)', reTrade.trade_id === dubaiSparky.id);
await expectError('changing BACK to the Northern trade while at a Dubai site is rejected', () =>
  demoApi.updateEmployee(branchWorker.id, empInput(northSparky.id, redCoast.id)));

// ---- 5. branch-scoped advance book ------------------------------------------
const marinaWorker = db.employees.find((e) => e.current_site_id === marinaSite.id)!;
db.advanceRecords.push({
  id: 'adv-north', employee_id: sharedWorker.id, amount: 100, given_date: '2026-11-01',
  cut_year: 2026, cut_month: 12, applied_amount: 0, note: null, source_period_id: null,
  created_by: raviP.id, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z',
});
db.advanceRecords.push({
  id: 'adv-marina', employee_id: marinaWorker.id,
  amount: 500, given_date: '2026-11-02', cut_year: 2026, cut_month: 12, applied_amount: 0,
  note: null, source_period_id: null, created_by: raviP.id,
  created_at: '2026-11-02T10:00:00.000Z', updated_at: '2026-11-02T10:00:00.000Z',
});
setDemoSessionId(raviP.id);
const raviBook = await demoApi.getAdvanceBook();
check('Ravi sees his branch employee advance', raviBook.records.some((r) => r.id === 'adv-north'));
check("Ravi does NOT see the Marina (Dubai) record outside his grants", !raviBook.records.some((r) => r.id === 'adv-marina'));
// totals stay consistent with the scoped records (seeded records included)
check('Ravi scoped totals reconcile with the scoped records',
  raviBook.totals.due_amount === raviBook.records.filter((r) => !r.cleared).reduce((s, r) => s + r.amount, 0));
setDemoSessionId(superP.id);
const superBook = await demoApi.getAdvanceBook();
check('super admin still sees the whole ledger', superBook.records.some((r) => r.id === 'adv-marina')
  && superBook.records.some((r) => r.id === 'adv-north'));

// cleanup the extra demo rows so a rerun stays deterministic
db.employees = db.employees.filter((e) => e.id !== sharedWorker.id && e.id !== branchWorker.id);
db.advanceRecords = db.advanceRecords.filter((r) => r.id !== 'adv-north' && r.id !== 'adv-marina');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

export {};
