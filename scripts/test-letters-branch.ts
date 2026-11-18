// Sanity check for the letters changes:
//  1. heading = Site Settings company name (fallback brand)
//  2. WhatsApp text carries the company name
//  3. termination body references the issuing company
//  4. the PDF employee grid keeps TRADE but drops Position & Performance Rating
//  5. advance-book style branch mapping math (record scoping) — mirror of the
//     component logic, verified against the same inputs
import { noticeCompanyHeading, buildNoticeBody, buildNoticeWhatsAppText, DEFAULT_COMPANY_NAME, type NoticeLetterData } from '../src/lib/notices';
import type { EmployeeVM } from '../src/lib/types';

const employee = {
  id: 'emp-1',
  full_name: 'Ramesh Kumar',
  employee_code: 'PUL-2024-001',
  nationality: 'India',
  date_of_birth: '1990-04-12',
  phone: '+966 512 345 678',
  position: 'Foreman',
  trade_name: 'Electrician',
  company_name: 'Alpha Contracting',
  branch_name: 'Riyadh',
  site_name: 'Tower Site',
  camp_name: null, camp_block: null, camp_room: null,
  join_date: '2023-01-15',
  passport_number: 'P1234567',
  id_number: '2456789',
  status: 'active',
  rating: 4.5,
  trade_id: null,
  salary_role: 'standard',
  opening_hours: 0,
  is_team_leader: false,
  team_leader_site_id: null,
  current_site_id: null,
  camp_id: null,
  payment_type: null,
  card_type_id: null,
  emergency_contact: null,
  email: null,
  address: null,
  photo: null,
  created_at: '2023-01-15T00:00:00.000Z',
  updated_at: '2023-01-15T00:00:00.000Z',
} as unknown as EmployeeVM;

let failures = 0;
const check = (name: string, cond: boolean): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
};

// 1. heading resolution
check('heading uses the given company name', noticeCompanyHeading('  Al Rajhi Contracting LLC ') === 'Al Rajhi Contracting LLC');
check('heading falls back to the brand when empty', noticeCompanyHeading('') === DEFAULT_COMPANY_NAME);
check('heading falls back to the brand when null', noticeCompanyHeading(null) === DEFAULT_COMPANY_NAME);

const data = {
  kind: 'warning',
  employee,
  recordId: 'a1b2c3d4-e5f6',
  reason: 'Repeated late arrival',
  createdAt: '2026-11-18T09:00:00.000Z',
  creatorName: 'Aisha',
  companyName: 'Al Rajhi Contracting LLC',
} as unknown as NoticeLetterData;

// 2. WhatsApp text
const waText = buildNoticeWhatsAppText(data);
check('WhatsApp text starts with the company name', waText.startsWith('*Al Rajhi Contracting LLC — WARNING LETTER*'));
check('WhatsApp text keeps the employee + code line', waText.includes('To: Ramesh Kumar (PUL-2024-001)'));
check('WhatsApp text keeps Created by', waText.includes('Created by: Aisha'));

// no companyName → employee's company → else brand
const waNoCompany = buildNoticeWhatsAppText({ ...data, companyName: null });
check('WhatsApp text falls back to the employee company', waNoCompany.startsWith('*Alpha Contracting — WARNING LETTER*'));
const waNothing = buildNoticeWhatsAppText({ ...data, companyName: null, employee: { ...employee, company_name: null } });
check('WhatsApp text falls back to the brand', waNothing.startsWith('*PULSE WORKFORCE OS LLC. — WARNING LETTER*'));

// 3. termination body references the issuing company
const termBody = buildNoticeBody({ ...data, kind: 'termination', effectiveDate: '2026-12-01', companyName: 'Al Rajhi Contracting LLC' });
check('termination body names the settings company', termBody.some((p) => p.includes('employment with Al Rajhi Contracting LLC')));
const termNoCompany = buildNoticeBody({ ...data, kind: 'termination', effectiveDate: '2026-12-01', companyName: null, employee: { ...employee, company_name: null } });
check('termination body says "the Company" when nothing is set', termNoCompany.some((p) => p.includes('employment with the Company')));

// 4. PDF employee grid — read the generator source and assert the columns
const pdfSource = (await import("node:fs")).readFileSync(new URL('../src/lib/pdf.ts', import.meta.url), 'utf8');
const grid = pdfSource.slice(pdfSource.indexOf('const leftCol'), pdfSource.indexOf("section('NOTICE DETAILS')"));
check('PDF grid keeps Trade', grid.includes("['Trade',"));
check('PDF grid drops Position', !grid.includes("['Position',"));
check('PDF grid drops Performance Rating', !grid.includes('Performance Rating'));
check('PDF heading uses the resolved company (not the hard-coded brand)', pdfSource.includes('doc.text(heading, pageW / 2, y, { align: \'center\' })'));

// 5. branch scoping math (mirror of the Advance Book / Trade page logic)
const sites = [
  { id: 's1', branch_id: 'br1' },
  { id: 's2', branch_id: 'br2' },
  { id: 's3', branch_id: null },
];
const employeesList = [
  { id: 'e1', current_site_id: 's1', trade_id: 't1', status: 'active' },
  { id: 'e2', current_site_id: 's2', trade_id: 't2', status: 'active' },
  { id: 'e3', current_site_id: 's3', trade_id: 't2', status: 'active' },
  { id: 'e4', current_site_id: null, trade_id: null, status: 'active' },
];
const branchIdOfSite = new Map(sites.map((s) => [s.id, s.branch_id]));
const branchIdOfEmployee = new Map(employeesList.map((e) => [
  e.id, e.current_site_id ? branchIdOfSite.get(e.current_site_id) ?? null : null,
]));
const records = [
  { id: 'r1', employee_id: 'e1' }, { id: 'r2', employee_id: 'e2' },
  { id: 'r3', employee_id: 'e3' }, { id: 'r4', employee_id: 'e4' },
];
const scope = (branchFilter: string) => branchFilter === 'all'
  ? records
  : records.filter((r) =>
    branchFilter === '__none__'
      ? (branchIdOfEmployee.get(r.employee_id) ?? null) === null
      : branchIdOfEmployee.get(r.employee_id) === branchFilter);
check('branch br1 scope → only e1 records', scope('br1').length === 1 && scope('br1')[0].id === 'r1');
check('branch br2 scope → only e2 records', scope('br2').length === 1 && scope('br2')[0].id === 'r2');
check('no-branch scope → e3 (unowned site) + e4 (idle)', scope('__none__').length === 2);
check('all scope → every record', scope('all').length === 4);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
