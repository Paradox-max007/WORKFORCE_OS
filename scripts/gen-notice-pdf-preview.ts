// Generates a real warning-letter PDF in node with the settings store company
// name set, then prints the extracted text so we can verify:
//   - the letterhead is the SETTINGS company name (not the hard-coded brand)
//   - the employee grid shows Trade and has NO Position / Performance Rating
//   - the Created-by identification is intact
import { useSettingsStore } from '../src/store/settings-store';
import { DEFAULT_SITE_SETTINGS } from '../src/lib/types';
import { generateNoticePdf } from '../src/lib/pdf';
import { noticePdfFilename, type NoticeLetterData } from '../src/lib/notices';

useSettingsStore.setState({
  settings: { ...DEFAULT_SITE_SETTINGS, company_name: 'Al Rajhi Contracting & Maintenance LLC' },
  loaded: true,
});

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
  branch_name: 'Riyadh Branch',
  site_name: 'Tower Site',
  camp_name: 'Camp A', camp_block: 'B', camp_room: '12',
  join_date: '2023-01-15',
  passport_number: 'P1234567',
  id_number: '2456789',
  status: 'active',
  rating: 4.5,
} as never;

const data: NoticeLetterData = {
  kind: 'warning',
  employee,
  recordId: 'a1b2c3d4-e5f6',
  reason: 'Repeated late arrival to the Tower Site without notice',
  createdAt: '2026-11-18T09:00:00.000Z',
  creatorName: 'Aisha Rahman',
  isAuto: false,
};

const doc = generateNoticePdf(data); // NOTE: no explicit companyName → store must supply it
doc.save(noticePdfFilename(data).replace('.pdf', '-node.pdf'));
