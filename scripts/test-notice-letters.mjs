// Unit tests for the formal letters & notices feature (Notifications Hub):
//   • reference codes, creator identification, WhatsApp number sanitisation
//   • letter bodies (standard + custom) for all three document kinds
//   • the WhatsApp message text
//   • REAL PDF generation through jsPDF (bytes + embedded text assertions)
//
// run: bun scripts/test-notice-letters.mjs   (node works too)
import assert from 'node:assert/strict';

const notices = await import('../src/lib/notices.ts');
const {
  noticeRef, noticeTitle, noticeLabel, noticeCreatorLine,
  buildNoticeBody, buildNoticeWhatsAppText, sanitizeWhatsAppNumber, noticePdfFilename,
} = notices;

const { generateNoticePdf } = await import('../src/lib/pdf.ts');

// ---- fixture employee (full EmployeeVM shape) ------------------------------
const employee = {
  id: 'emp-1', full_name: 'Rajesh Kumar', employee_code: 'PUL-2026-001',
  nationality: 'India', date_of_birth: '1992-05-14', phone: '+966 512 345 678',
  email: null, address: 'Mumbai, India', emergency_contact: '+966 501 234 567',
  position: 'Electrician', join_date: '2025-03-15', company_name: 'Arabian Shield Manpower',
  passport_number: 'P1543211', passport_status: 'Valid', id_number: 'UAE-IQ-20260001',
  id_status: 'Valid', current_site_id: 's1', camp_id: null, camp_block: 'B2', camp_room: '104',
  rating: 4.5, status: 'active', photo: null, payment_type: 'cash', card_type_id: null,
  is_team_leader: false, team_leader_site_id: null, opening_hours: 2400, trade_id: 't1',
  salary_role: 'standard', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
  site_name: 'Marina Tower', branch_name: 'Dubai Central Branch', leader_site_name: null,
  camp_name: 'Al Quoz Camp', trade_name: 'Electrician', card_type_name: null,
};

const base = {
  employee,
  reason: 'Repeated late arrivals to the morning shift.',
  createdAt: '2026-11-17T08:30:00.000Z',
  creatorName: 'Priya Menon',
  recordId: '1a2b3c4d-1111-2222-3333-444455556666',
};

let passed = 0;
const ok = (label) => { passed++; console.log('ok  ', label); };

// ---- 1. reference codes ------------------------------------------------------
assert.equal(noticeRef('warning', base.recordId), 'WARN-1A2B3C4D');
assert.equal(noticeRef('termination', base.recordId), 'TERM-1A2B3C4D');
assert.equal(noticeRef('fine', base.recordId), 'FINE-1A2B3C4D');
assert.equal(noticeTitle('warning'), 'WARNING LETTER');
assert.equal(noticeTitle('termination'), 'TERMINATION LETTER');
assert.equal(noticeTitle('fine'), 'FINE NOTICE');
assert.equal(noticeLabel('fine'), 'Fine Notice');
ok('reference codes + titles');

// ---- 2. creator identification ----------------------------------------------
assert.equal(noticeCreatorLine('Priya Menon'), 'Created by: Priya Menon');
assert.equal(noticeCreatorLine(null), 'Created by: System');
assert.equal(noticeCreatorLine('Priya Menon', true), 'Created by: System (Auto-generated)');
assert.equal(noticeCreatorLine('  '), 'Created by: System');
ok('creator identification (user name / System / auto)');

// ---- 3. WhatsApp number sanitisation ----------------------------------------
assert.equal(sanitizeWhatsAppNumber('+966 512 345 678'), '966512345678');
assert.equal(sanitizeWhatsAppNumber('05123456789'), '9665123456789');       // local Saudi → 966…
assert.equal(sanitizeWhatsAppNumber('00971 50 123 4567'), '971501234567');  // 00-prefix → international
assert.equal(sanitizeWhatsAppNumber('9715012345678'), '9715012345678');
assert.equal(sanitizeWhatsAppNumber('no digits here'), null);
assert.equal(sanitizeWhatsAppNumber(''), null);
assert.equal(sanitizeWhatsAppNumber(null), null);
ok('WhatsApp number sanitisation');

// ---- 4. letter bodies ---------------------------------------------------------
const warnBody = buildNoticeBody({ ...base, kind: 'warning' });
assert.ok(warnBody.join(' ').includes('formal written warning'), 'warning wording');
assert.ok(warnBody.join(' ').includes(base.reason));
assert.ok(warnBody.join(' ').includes('Dear Mr./Ms. Kumar'));

const autoWarnBody = buildNoticeBody({
  ...base, kind: 'warning', isAuto: true, creatorName: null,
  absentDates: ['2026-11-10', '2026-11-11', '2026-11-12'],
});
assert.ok(autoWarnBody.join(' ').includes('absent'), 'auto warning mentions absences');
assert.ok(autoWarnBody.join(' ').includes('10/11/2026'));

const fineBody = buildNoticeBody({ ...base, kind: 'fine', amount: 250.5 });
assert.ok(fineBody.join(' ').includes('SAR 250.50'), 'fine amount in body');

const termBody = buildNoticeBody({
  ...base, kind: 'termination', effectiveDate: '2026-12-01', noticeBasis: 'payment_in_lieu',
});
assert.ok(termBody.join(' ').includes('effective 01/12/2026'), 'termination effective date');
assert.ok(termBody.join(' ').includes('payment in lieu of notice'), 'termination basis');
assert.ok(termBody.join(' ').includes('Arabian Shield Manpower'), 'company in termination');

const customBody = buildNoticeBody({
  ...base, kind: 'termination', effectiveDate: '2026-12-01',
  noticeBasis: 'immediate', customBody: 'First paragraph.\n\nSecond paragraph.',
});
assert.deepEqual(customBody, ['First paragraph.', 'Second paragraph.'], 'custom body replaces standard text');
ok('letter bodies (warning / auto-warning / fine / termination / custom)');

// ---- 5. WhatsApp message text --------------------------------------------------
const waText = buildNoticeWhatsAppText({ ...base, kind: 'fine', amount: 120 });
assert.ok(waText.includes('FINE NOTICE'));
assert.ok(waText.includes('Rajesh Kumar (PUL-2026-001)'));
assert.ok(waText.includes('FINE-1A2B3C4D'));
assert.ok(waText.includes('SAR 120.00'));
assert.ok(waText.includes('Created by: Priya Menon'));
assert.ok(waText.length < 1500, 'keeps wa.me URL friendly');
ok('WhatsApp message text');

// ---- 6. PDF file names ----------------------------------------------------------
assert.equal(noticePdfFilename({ ...base, kind: 'warning' }), 'warning-letter-rajesh-kumar-1a2b3c4d.pdf');
ok('PDF file names');

// ---- 7. REAL PDF generation (all three kinds) -----------------------------------
// jsPDF writes uncompressed content streams → key strings are searchable in the
// raw PDF bytes, proving the letter really carries the employee details and the
// creator identification.
const cases = [
  { ...base, kind: 'warning' },
  { ...base, kind: 'fine', amount: 250.5 },
  { ...base, kind: 'termination', effectiveDate: '2026-12-01', noticeBasis: 'with_notice' },
];
for (const data of cases) {
  const doc = generateNoticePdf(data);
  const raw = Buffer.from(doc.output('arraybuffer')).toString('latin1');
  assert.ok(doc.getNumberOfPages() >= 1, `${data.kind}: has pages`);
  assert.ok(raw.length > 2000, `${data.kind}: substantial PDF`);
  assert.ok(raw.includes(noticeTitle(data.kind)), `${data.kind}: title embedded`);
  assert.ok(raw.includes('Rajesh Kumar'), `${data.kind}: employee name embedded`);
  assert.ok(raw.includes('PUL-2026-001'), `${data.kind}: employee code embedded`);
  assert.ok(raw.includes('India'), `${data.kind}: nationality embedded`);
  assert.ok(raw.includes('Marina Tower'), `${data.kind}: site embedded`);
  assert.ok(raw.includes('Electrician'), `${data.kind}: position embedded`);
  assert.ok(raw.includes('Created by: Priya Menon'), `${data.kind}: creator identification embedded`);
  assert.ok(raw.includes(noticeRef(data.kind, base.recordId)), `${data.kind}: reference embedded`);
  assert.ok(raw.includes('Employee Signature'), `${data.kind}: signature block`);
}
ok('PDF generation — all three kinds carry employee details + creator line');

// auto-generated warning letter must be identified as System
// (jsPDF escapes parentheses inside PDF strings: "System \(Auto-generated\)")
const autoDoc = generateNoticePdf({ ...base, kind: 'warning', isAuto: true, creatorName: 'Someone', absentDates: ['2026-11-10'] });
const autoRaw = Buffer.from(autoDoc.output('arraybuffer')).toString('latin1');
assert.ok(autoRaw.includes('Created by: System \\(Auto-generated\\)'), 'auto warning letter: System identification');
assert.ok(autoRaw.includes('Auto-generated \\(attendance policy\\)'), 'auto warning letter: warning type noted');
ok('auto-generated warning letter identified as System');

console.log(`\nNOTICE LETTERS TESTS PASSED (${passed} groups)`);
