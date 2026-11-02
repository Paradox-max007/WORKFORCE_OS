-- ============================================================================
-- Trade & Salary system — end-to-end functional verification (October 2026)
-- Run as the seeded super admin. Every DO block ends with a PASS notice;
-- any mismatch raises an exception (with ON_ERROR_STOP the file aborts).
-- ============================================================================
set app.current_uid = '00000000-0000-0000-0000-0000000000aa';

create temp table if not exists tt (key text primary key, val text);

-- ---------------------------------------------------------------------------
-- Fixtures: sites, trades (complete / partial-draft), five employees
-- ---------------------------------------------------------------------------
do $$
declare s1 uuid; s2 uuid; r jsonb;
begin
  insert into public.site (name) values ('Marina Tower') returning id into s1;
  insert into public.site (name) values ('Desert Mall')  returning id into s2;
  insert into tt values ('s1', s1::text), ('s2', s2::text);

  r := public.create_trade('Electrician', 'Wiring and fixtures', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',8),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',12),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',10),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',15),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',12),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',18)
  ), true);
  insert into tt values ('trade_elec', r->>'id');

  -- draft trade with only below-threshold cells → stays inactive
  r := public.create_trade('Helper', 'Partial rates draft', jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',6),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',7),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',8)
  ), false);
  insert into tt values ('trade_helper', r->>'id');
  if r->>'is_active' <> 'false' then raise exception 'FAIL partial trade activated'; end if;
end $$;

-- backdate all six cells to 2026-10-01 (super admin), then a mid-month
-- change: standard/qualified 12 → 13 from 2026-10-16
do $$
declare elec uuid := (select val::uuid from tt where key = 'trade_elec');
begin
  perform public.update_trade_rates(elec, jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',8),
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',12),
    jsonb_build_object('salary_role','team_leader','experience_tier','below_threshold','hourly_rate',10),
    jsonb_build_object('salary_role','team_leader','experience_tier','qualified','hourly_rate',15),
    jsonb_build_object('salary_role','supervisor','experience_tier','below_threshold','hourly_rate',12),
    jsonb_build_object('salary_role','supervisor','experience_tier','qualified','hourly_rate',18)
  ), date '2026-10-01');
  perform public.update_trade_rates(elec, jsonb_build_array(
    jsonb_build_object('salary_role','standard','experience_tier','qualified','hourly_rate',13)
  ), date '2026-10-16');
end $$;

do $$
declare r public.employee;
begin
  -- A: crosses 1,000 lifetime hours mid-shift (opening 996, joined recently)
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','Ravi Threshold','join_date','2026-09-01','opening_hours','996',
    'current_site_id',(select val from tt where key='s1'),
    'trade_id',(select val from tt where key='trade_elec'),
    'salary_role','standard','position','Electrician'));
  insert into tt values ('emp_a', r.id::text);

  -- B: six-month boundary (join 2026-04-15 → 2026-10-15)
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','Sam Sixmonth','join_date','2026-04-15','opening_hours','0',
    'current_site_id',(select val from tt where key='s1'),
    'trade_id',(select val from tt where key='trade_elec'),
    'salary_role','standard','position','Electrician'));
  insert into tt values ('emp_b', r.id::text);

  -- C: opening balance ≥ 1000 → qualified from employment start, team_leader
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','Omar Opening','join_date','2026-10-01','opening_hours','1500',
    'current_site_id',(select val from tt where key='s2'),
    'trade_id',(select val from tt where key='trade_elec'),
    'salary_role','team_leader','position','Foreman'));
  insert into tt values ('emp_c', r.id::text);

  -- D: no trade assigned
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','NoTrade Dave','join_date','2026-09-01','opening_hours','0',
    'current_site_id',(select val from tt where key='s1'),'position','Labourer'));
  insert into tt values ('emp_d', r.id::text);
  if r.trade_id is not null then raise exception 'FAIL D has a trade'; end if;

  -- activate the partial-rate draft and assign E (qualified via opening 1200,
  -- but the Helper trade has no qualified rate → unrated hours)
  perform public.update_trade((select val::uuid from tt where key='trade_helper'), 'Helper', null, true);
  select * into r from public.create_employee(jsonb_build_object(
    'full_name','MissingRate Ed','join_date','2026-10-01','opening_hours','1200',
    'current_site_id',(select val from tt where key='s2'),
    'trade_id',(select val from tt where key='trade_helper'),
    'salary_role','standard','position','Helper'));
  insert into tt values ('emp_e', r.id::text);
end $$;

-- attendance for October 2026
do $$
begin
  insert into public.attendance (employee_id, date, status, hours) values
    ((select val::uuid from tt where key='emp_a'), date '2026-10-05', 'present', 10),
    ((select val::uuid from tt where key='emp_a'), date '2026-10-06', 'present', 8),
    ((select val::uuid from tt where key='emp_a'), date '2026-10-20', 'present', 8),
    ((select val::uuid from tt where key='emp_b'), date '2026-10-14', 'present', 5),
    ((select val::uuid from tt where key='emp_b'), date '2026-10-15', 'present', 5),
    ((select val::uuid from tt where key='emp_b'), date '2026-10-16', 'present', 5),
    ((select val::uuid from tt where key='emp_c'), date '2026-10-10', 'present', 10),
    ((select val::uuid from tt where key='emp_d'), date '2026-10-05', 'present', 7),
    ((select val::uuid from tt where key='emp_e'), date '2026-10-08', 'present', 10);
end $$;

-- A moves S1 → S2 effective 2026-10-16 (full payload, like the real form)
do $$
begin
  perform public.update_employee((select val::uuid from tt where key='emp_a'), jsonb_build_object(
    'full_name','Ravi Threshold','join_date','2026-09-01','opening_hours','996',
    'current_site_id',(select val from tt where key='s2'),
    'trade_id',(select val from tt where key='trade_elec'),
    'salary_role','standard','position','Electrician'),
    date '2026-10-16');
end $$;

-- ---------------------------------------------------------------------------
-- Eligibility engine
-- ---------------------------------------------------------------------------
do $$
declare v jsonb;
begin
  v := public.get_employee_salary_eligibility((select val::uuid from tt where key='emp_a'), date '2026-10-04');
  if v->>'qualified' <> 'false' then raise exception 'FAIL A@10-04 qualified=%', v->>'qualified'; end if;
  if v->>'threshold_date' <> '2026-10-05' then raise exception 'FAIL A threshold_date=%', v->>'threshold_date'; end if;
  if v->>'six_month_date' <> '2027-03-01' then raise exception 'FAIL A six_month=%', v->>'six_month_date'; end if;
  if (v->>'current_rate')::numeric <> 8 then raise exception 'FAIL A rate@10-04=%', v->>'current_rate'; end if;

  v := public.get_employee_salary_eligibility((select val::uuid from tt where key='emp_a'), date '2026-10-06');
  if v->>'qualified' <> 'true' then raise exception 'FAIL A@10-06 qualified=%', v->>'qualified'; end if;
  if v->>'qualification_reason' <> 'thousand_hours' then raise exception 'FAIL A reason=%', v->>'qualification_reason'; end if;
  if v->>'qualification_date' <> '2026-10-05' then raise exception 'FAIL A qual_date=%', v->>'qualification_date'; end if;
  if (v->>'current_rate')::numeric <> 12 then raise exception 'FAIL A rate@10-06=%', v->>'current_rate'; end if;
  if (v->>'lifetime_hours')::numeric <> 1022 then raise exception 'FAIL A lifetime=%', v->>'lifetime_hours'; end if;

  v := public.get_employee_salary_eligibility((select val::uuid from tt where key='emp_b'), date '2026-10-14');
  if v->>'qualified' <> 'false' then raise exception 'FAIL B@10-14 qualified=%', v->>'qualified'; end if;
  v := public.get_employee_salary_eligibility((select val::uuid from tt where key='emp_b'), date '2026-10-15');
  if v->>'qualified' <> 'true' or v->>'qualification_reason' <> 'six_months' then
    raise exception 'FAIL B@10-15 qualified=% reason=%', v->>'qualified', v->>'qualification_reason';
  end if;

  v := public.get_employee_salary_eligibility((select val::uuid from tt where key='emp_c'), date '2026-10-10');
  if v->>'qualified' <> 'true' or v->>'qualification_reason' <> 'opening_balance'
     or v->>'qualification_date' <> '2026-10-01' then
    raise exception 'FAIL C: %', v::text;
  end if;
  if (v->>'current_rate')::numeric <> 15 then raise exception 'FAIL C rate=%', v->>'current_rate'; end if;

  v := public.get_employee_salary_eligibility((select val::uuid from tt where key='emp_e'), date '2026-10-08');
  if v->>'qualified' <> 'true' then raise exception 'FAIL E qualified'; end if;
  if v->>'current_rate' is not null then raise exception 'FAIL E rate should be missing: %', v->>'current_rate'; end if;

  raise notice 'PASS: eligibility engine (threshold split, six-month, opening balance)';
end $$;

-- ---------------------------------------------------------------------------
-- Payroll generation + salary sheet (site grouping, totals, invariants)
-- ---------------------------------------------------------------------------
do $$
declare v jsonb;
begin
  perform public.generate_payroll_period(2026, 10);
  v := public.get_salary_sheet(2026, 10);

  if v->>'exists' <> 'true' then raise exception 'FAIL sheet exists'; end if;
  if v->'period'->>'status' <> 'draft' then raise exception 'FAIL status=%', v->'period'->>'status'; end if;
  if (v->'totals'->>'employees')::int <> 5 then raise exception 'FAIL employees=%', v->'totals'->>'employees'; end if;
  if (v->'totals'->>'total_hours')::numeric <> 68 then raise exception 'FAIL hours=%', v->'totals'->>'total_hours'; end if;
  if (v->'totals'->>'gross_salary')::numeric <> 619 then raise exception 'FAIL gross=%', v->'totals'->>'gross_salary'; end if;
  if (v->'totals'->>'net_payable')::numeric <> 619 then raise exception 'FAIL net=%', v->'totals'->>'net_payable'; end if;
  if (v->'totals'->>'unpaid_count')::int <> 5 then raise exception 'FAIL unpaid=%', v->'totals'->>'unpaid_count'; end if;

  if jsonb_array_length(v->'sites') <> 3 then raise exception 'FAIL site groups=%', jsonb_array_length(v->'sites'); end if;
  if v->'sites'->0->>'site_name' <> 'Marina Tower' or (v->'sites'->0->>'gross_salary')::numeric <> 365
     or (v->'sites'->0->>'total_hours')::numeric <> 33 or (v->'sites'->0->>'employees')::int <> 2 then
    raise exception 'FAIL site1=%', v->'sites'->0;
  end if;
  if v->'sites'->1->>'site_name' <> 'Desert Mall' or (v->'sites'->1->>'gross_salary')::numeric <> 254
     or (v->'sites'->1->>'total_hours')::numeric <> 18 or (v->'sites'->1->>'employees')::int <> 2 then
    raise exception 'FAIL site2=%', v->'sites'->1;
  end if;
  if v->'sites'->2->>'site_name' <> 'No site' or (v->'sites'->2->>'gross_salary')::numeric <> 0
     or (v->'sites'->2->>'total_hours')::numeric <> 17 or (v->'sites'->2->>'employees')::int <> 2 then
    raise exception 'FAIL nosite=%', v->'sites'->2;
  end if;
  raise notice 'PASS: payroll generation + site grouping';
end $$;

do $$
declare v jsonb; a jsonb;
begin
  v := public.get_salary_sheet(2026, 10);
  if jsonb_array_length(v->'employees') <> 5 then raise exception 'FAIL employee rows'; end if;

  -- employees ordered by full_name: Ed, Dave, Omar, Ravi, Sam
  a := v->'employees'->3;
  if a->>'full_name' <> 'Ravi Threshold' then raise exception 'FAIL order[3]=%', a->>'full_name'; end if;
  if (a->>'total_hours')::numeric <> 26 then raise exception 'FAIL A total=%', a->>'total_hours'; end if;
  if (a->>'below_threshold_hours')::numeric <> 4 then raise exception 'FAIL A below=%', a->>'below_threshold_hours'; end if;
  if (a->>'qualified_hours')::numeric <> 22 then raise exception 'FAIL A qualified=%', a->>'qualified_hours'; end if;
  if (a->>'gross_salary')::numeric <> 304 then raise exception 'FAIL A gross=%', a->>'gross_salary'; end if;
  if jsonb_array_length(a->'sites') <> 2 then raise exception 'FAIL A sites=%', jsonb_array_length(a->'sites'); end if;
  if (a->'sites'->0->>'gross_salary')::numeric <> 200 or (a->'sites'->0->>'total_hours')::numeric <> 18 then
    raise exception 'FAIL A site0=%', a->'sites'->0;
  end if;
  if (a->'sites'->1->>'gross_salary')::numeric <> 104 or (a->'sites'->1->>'total_hours')::numeric <> 8 then
    raise exception 'FAIL A site1=%', a->'sites'->1;
  end if;
  -- A's S1 lines: 10-05 split (4h@8 + 6h@12) and 10-06 (8h@12); S2: 10-20 (8h@13)
  if jsonb_array_length(a->'sites'->0->'lines') <> 3 then raise exception 'FAIL A s1 lines'; end if;
  if jsonb_array_length(a->'sites'->1->'lines') <> 1 then raise exception 'FAIL A s2 lines'; end if;
  if (a->'sites'->1->'lines'->0->>'hours')::numeric <> 8
     or (a->'sites'->1->'lines'->0->>'hourly_rate')::numeric <> 13
     or (a->'sites'->1->'lines'->0->>'gross_amount')::numeric <> 104 then
    raise exception 'FAIL A s2 line=%', a->'sites'->1->'lines'->0;
  end if;
  -- financial invariant: Σ line amounts = employee gross
  if (select sum((l->>'gross_amount')::numeric)
      from jsonb_array_elements(a->'sites') s, jsonb_array_elements(s->'lines') l) <> 304 then
    raise exception 'FAIL A line-sum invariant';
  end if;

  -- C: team_leader qualified all month
  if v->'employees'->2->>'full_name' <> 'Omar Opening'
     or (v->'employees'->2->>'gross_salary')::numeric <> 150
     or v->'employees'->2->>'salary_role' <> 'team_leader' then
    raise exception 'FAIL C=%', v->'employees'->2;
  end if;

  -- E: unrated hours, zero gross, missing-rate flag
  if v->'employees'->0->>'full_name' <> 'MissingRate Ed'
     or (v->'employees'->0->>'unrated_hours')::numeric <> 10
     or (v->'employees'->0->>'gross_salary')::numeric <> 0 then
    raise exception 'FAIL E=%', v->'employees'->0;
  end if;
  if v->'employees'->0->'sites'->0->>'has_missing_rate' <> 'true' then
    raise exception 'FAIL E missing-rate flag=%', v->'employees'->0->'sites'->0;
  end if;

  -- D: unassigned hours (no trade)
  if v->'employees'->1->>'full_name' <> 'NoTrade Dave'
     or (v->'employees'->1->>'unassigned_hours')::numeric <> 7 then
    raise exception 'FAIL D=%', v->'employees'->1;
  end if;

  -- global invariant: Σ employee gross = sheet total gross
  if (select sum((e->>'gross_salary')::numeric) from jsonb_array_elements(v->'employees') e)
     <> (v->'totals'->>'gross_salary')::numeric then
    raise exception 'FAIL employees-vs-totals invariant';
  end if;

  insert into tt values ('pe_a', a->>'id')
    on conflict (key) do update set val = excluded.val;
  raise notice 'PASS: employee settlements, line breakdown, invariants';
end $$;

-- ---------------------------------------------------------------------------
-- Adjustments → finalize → payment → reopen (with audit)
-- ---------------------------------------------------------------------------
do $$
declare pe_a uuid; pe_b uuid; period uuid; v jsonb;
begin
  select val::uuid into pe_a from tt where key = 'pe_a';
  select id into period from public.payroll_period where year = 2026 and month = 10;
  select pe.id into pe_b from public.payroll_employee pe
    where pe.payroll_period_id = period
      and pe.employee_id = (select val::uuid from tt where key = 'emp_b');

  perform public.update_payroll_adjustment(pe_a, 50, 20, 'advance + medical deduction');

  begin
    perform public.update_payroll_adjustment(pe_a, -1, 0, null);
    raise exception 'FAIL negative advance accepted';
  exception when others then
    if sqlerrm not like '%Advance must be%' then raise; end if;
  end;

  perform public.finalize_payroll_period(period);

  begin
    perform public.generate_payroll_period(2026, 10);
    raise exception 'FAIL regenerate finalized accepted';
  exception when others then
    if sqlerrm not like '%finalized%' then raise; end if;
  end;

  v := public.get_salary_sheet(2026, 10);
  if v->'period'->>'status' <> 'finalized' then raise exception 'FAIL finalized status'; end if;
  if (v->'totals'->>'advances')::numeric <> 50 or (v->'totals'->>'deductions')::numeric <> 20
     or (v->'totals'->>'net_payable')::numeric <> 549 then
    raise exception 'FAIL totals after adjust=%', v->'totals';
  end if;

  perform public.mark_employee_salary_paid(pe_a, null, null, null);

  begin
    perform public.update_payroll_adjustment(pe_a, 10, 10, null);
    raise exception 'FAIL adjust paid accepted';
  exception when others then
    if sqlerrm not like '%already marked paid%' then raise; end if;
  end;

  -- adjustments still allowed for an unpaid employee in a finalized period
  perform public.update_payroll_adjustment(pe_b, 10, 0, null);

  v := public.get_salary_sheet(2026, 10);
  if (v->'totals'->>'paid_count')::int <> 1 then raise exception 'FAIL paid_count=%', v->'totals'->>'paid_count'; end if;
  if (v->'totals'->>'net_payable')::numeric <> 539 then raise exception 'FAIL net after B adjust=%', v->'totals'->>'net_payable'; end if;

  perform public.reopen_payroll_period(period, 'October correction — attendance fix');

  begin
    perform public.reopen_payroll_period(period, '   ');
    raise exception 'FAIL reopen without reason accepted';
  exception when others then
    if sqlerrm not like '%reason is required%' then raise; end if;
  end;

  -- draft again → regenerate keeps adjustments + payment state
  perform public.generate_payroll_period(2026, 10);
  v := public.get_salary_sheet(2026, 10);
  if v->'period'->>'status' <> 'draft' then raise exception 'FAIL reopen status'; end if;
  if (select (e->>'advance')::numeric from jsonb_array_elements(v->'employees') e
      where e->>'full_name' = 'Ravi Threshold') <> 50 then
    raise exception 'FAIL A advance lost after regenerate';
  end if;
  if (select coalesce(e->>'payment_status','') from jsonb_array_elements(v->'employees') e
      where e->>'full_name' = 'Ravi Threshold') <> 'paid' then
    raise exception 'FAIL A payment lost after regenerate';
  end if;
  if jsonb_array_length(v->'audit') < 3 then raise exception 'FAIL audit rows=%', jsonb_array_length(v->'audit'); end if;
  if v->'audit'->0->>'action' <> 'reopen' then raise exception 'FAIL audit order=%', v->'audit'->0; end if;

  raise notice 'PASS: adjustments, finalize, payment, reopen lifecycle';
end $$;

-- ---------------------------------------------------------------------------
-- Effective-dated rate history + trade listing
-- ---------------------------------------------------------------------------
do $$
declare v jsonb; elec uuid; cnt int;
begin
  select val::uuid into elec from tt where key = 'trade_elec';
  v := public.get_trade_rate_history(elec);
  -- 5 cells × 2 periods + standard/qualified × 3 = 13 rows
  if jsonb_array_length(v) <> 13 then raise exception 'FAIL rate history rows=%', jsonb_array_length(v); end if;
  select count(*) into cnt from jsonb_array_elements(v) r
    where r->>'salary_role' = 'standard' and r->>'experience_tier' = 'qualified';
  if cnt <> 3 then raise exception 'FAIL std/qual periods=%', cnt; end if;
  select count(*) into cnt from jsonb_array_elements(v) r
    where r->>'salary_role' = 'standard' and r->>'experience_tier' = 'qualified'
      and r->>'effective_from' = '2026-10-01' and r->>'effective_to' = '2026-10-15'
      and (r->>'hourly_rate')::numeric = 12;
  if cnt <> 1 then raise exception 'FAIL period 10-01..10-15 missing'; end if;
  select count(*) into cnt from jsonb_array_elements(v) r
    where r->>'salary_role' = 'standard' and r->>'experience_tier' = 'qualified'
      and r->>'effective_from' = '2026-10-16' and (r->>'hourly_rate')::numeric = 13;
  if cnt <> 1 then raise exception 'FAIL period 10-16 missing'; end if;

  v := public.list_trades();
  if jsonb_array_length(v) <> 2 then raise exception 'FAIL trades=%', jsonb_array_length(v); end if;
  if v->0->>'name' <> 'Electrician' or jsonb_array_length(v->0->'current_rates') <> 6 then
    raise exception 'FAIL elec current rates=%', v->0;
  end if;
  select count(*) into cnt from jsonb_array_elements(v->0->'current_rates') r
    where r->>'salary_role' = 'standard' and r->>'experience_tier' = 'qualified'
      and (r->>'hourly_rate')::numeric = 12;
  if cnt <> 1 then raise exception 'FAIL today std/qual rate should be 12'; end if;

  raise notice 'PASS: effective-dated rate history + trade listing';
end $$;

-- ---------------------------------------------------------------------------
-- Assignment history (the function that failed in Supabase) + on-date lookup
-- ---------------------------------------------------------------------------
do $$
declare a uuid; elec uuid; v jsonb; role text;
begin
  select val::uuid into a from tt where key = 'emp_a';
  select val::uuid into elec from tt where key = 'trade_elec';
  perform public.assign_employee_trade(a, elec, 'team_leader', date '2026-10-21');

  v := public.get_employee_salary_history(a);
  if jsonb_array_length(v) <> 2 then raise exception 'FAIL history len=%', jsonb_array_length(v); end if;
  if v->0->>'salary_role' <> 'team_leader' or v->0->>'effective_from' <> '2026-10-21' then
    raise exception 'FAIL history[0]=%', v->0;
  end if;
  if v->1->>'salary_role' <> 'standard' or v->1->>'effective_from' <> '2026-09-01'
     or v->1->>'effective_to' <> '2026-10-20' then
    raise exception 'FAIL history[1]=%', v->1;
  end if;
  if v->0->>'trade_name' <> 'Electrician' or v->0->>'employee_name' <> 'Ravi Threshold' then
    raise exception 'FAIL history enrichment=%', v->0;
  end if;

  v := public.emp_trade_on_date(a, date '2026-10-20');
  if v->>'salary_role' <> 'standard' then raise exception 'FAIL role@10-20=%', v->>'salary_role'; end if;
  v := public.emp_trade_on_date(a, date '2026-10-21');
  if v->>'salary_role' <> 'team_leader' then raise exception 'FAIL role@10-21=%', v->>'salary_role'; end if;

  select e.salary_role into role from public.employee e where e.id = a;
  if role <> 'team_leader' then raise exception 'FAIL employee current role=%', role; end if;

  raise notice 'PASS: effective-dated assignment history (the fixed RPC)';
end $$;

-- ---------------------------------------------------------------------------
-- Guards: overlap trigger, duplicate names, activation gate, permissions
-- ---------------------------------------------------------------------------
do $$
declare elec uuid;
begin
  select val::uuid into elec from tt where key = 'trade_elec';
  begin
    insert into public.trade_rate_history (trade_id, salary_role, experience_tier, hourly_rate, effective_from)
    values (elec, 'standard', 'qualified', 99, date '2026-10-10');
    raise exception 'FAIL overlapping rate accepted';
  exception when others then
    if sqlerrm not like '%Overlapping%' then raise; end if;
  end;
  raise notice 'PASS: no-overlap guard trigger';
end $$;

do $$
begin
  begin
    perform public.create_trade('  electrician ', null, '[]'::jsonb, false);
    raise exception 'FAIL duplicate trade name accepted';
  exception when others then
    if sqlerrm not like '%already exists%' then raise; end if;
  end;
  begin
    perform public.create_trade('HalfTrade', null, jsonb_build_array(
      jsonb_build_object('salary_role','standard','experience_tier','below_threshold','hourly_rate',5)), true);
    raise exception 'FAIL incomplete activation accepted';
  exception when others then
    if sqlerrm not like '%six rate cells%' then raise; end if;
  end;
  raise notice 'PASS: trade name uniqueness + activation gate';
end $$;

do $$
begin
  perform set_config('app.current_uid', '00000000-0000-0000-0000-0000000000bb', false);
  begin
    perform public.create_trade('Rogue', null, '[]'::jsonb, false);
    raise exception 'FAIL plain admin created a trade';
  exception when others then
    if sqlerrm not like '%Access denied%' then raise; end if;
  end;
  begin
    perform public.get_salary_sheet(2026, 10);
    raise exception 'FAIL plain admin read the salary sheet';
  exception when others then
    if sqlerrm not like '%Access denied%' then raise; end if;
  end;
  begin
    perform public.calculate_employee_payroll((select val::uuid from tt where key='emp_a'), 2026, 10);
    raise exception 'FAIL plain admin ran the calculation';
  exception when others then
    if sqlerrm not like '%Access denied%' then raise; end if;
  end;
  begin
    perform public.get_employee_salary_history((select val::uuid from tt where key='emp_a'));
    raise exception 'FAIL plain admin read salary history';
  exception when others then
    if sqlerrm not like '%Access denied%' then raise; end if;
  end;
  -- staff (any admin) may still read the trade list for the employee form
  perform public.list_trades();
  perform set_config('app.current_uid', '00000000-0000-0000-0000-0000000000aa', false);
  raise notice 'PASS: permission guards (financial RPCs denied, trade list allowed for staff)';
end $$;

-- ---------------------------------------------------------------------------
-- Storage-level invariants
-- ---------------------------------------------------------------------------
do $$
declare n int; s numeric;
begin
  select count(*) into n from public.payroll_salary_line;
  if n <> 8 then raise exception 'FAIL salary lines=% (expected 8)', n; end if;
  select count(*) into n from public.payroll_employee_site;
  if n <> 6 then raise exception 'FAIL site rows=% (expected 6)', n; end if;
  select coalesce(sum(gross_amount), 0) into s from public.payroll_salary_line;
  if s <> 619 then raise exception 'FAIL line gross sum=%', s; end if;
  select coalesce(sum(gross_salary), 0) into s from public.payroll_employee;
  if s <> 619 then raise exception 'FAIL employee gross sum=%', s; end if;
  select coalesce(sum(gross_salary), 0) into s from public.payroll_employee_site;
  if s <> 619 then raise exception 'FAIL site gross sum=%', s; end if;
  raise notice 'PASS: storage invariants (lines = employees = sites = 619 AED)';
end $$;
