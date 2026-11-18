// ============================================================================
// PULSE Workforce OS — Document field extraction (Add Employee auto-fill)
// ----------------------------------------------------------------------------
// Turns an uploaded passport / visa / Emirates ID / contract file (PDF or
// image) into form fields, powering "upload → automatically fill → complete
// the rest" on the Add/Edit Employee page.
//
// Pipeline per file type:
//   PDF   → local text extraction (pdf.js text layer, 1–3 pages)
//         → MRZ parse (machine-readable zone, TD3 passports / TD1 visas &
//           UAE Emirates ID cards) — deterministic, works fully offline
//         → + AI polish when the org configured an AI connection
//           (Site Settings → AI Bot): the raw text goes to the model with a
//           strict "reply ONLY JSON" prompt
//   IMAGE → AI vision only (base64 image to the configured OpenAI-compatible
//           provider — the /api/ai proxy accepts multimodal messages). Without
//           an AI connection images cannot be read automatically.
//
// Everything runs in the admin's browser / through the same-origin /api/ai
// proxy — nothing is sent to any third party other than the provider the
// organisation itself configured.
// ============================================================================

import { COUNTRIES } from '@/components/shared/nationality-select';

/** Fields the extractor can populate on the employee form. */
export interface ExtractedDocFields {
  full_name: string | null;
  nationality: string | null;
  date_of_birth: string | null; // YYYY-MM-DD
  passport_number: string | null;
  passport_expiry: string | null; // YYYY-MM-DD
  id_number: string | null;
  position: string | null;
  join_date: string | null; // YYYY-MM-DD (contract start)
}

export interface DocExtractResult {
  fields: ExtractedDocFields;
  /** how the values were obtained — shown to the admin for transparency */
  source: 'mrz' | 'ai-text' | 'ai-vision' | 'none';
  /** non-blocking explanation (e.g. why AI wasn't used) */
  note?: string;
}

export interface DocExtractAiOptions {
  /** true when Site Settings has an enabled, keyed AI connection */
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  /** DEMO mode only — the raw key from the local demo store */
  apiKey?: string;
}

const EMPTY: ExtractedDocFields = {
  full_name: null, nationality: null, date_of_birth: null,
  passport_number: null, passport_expiry: null,
  id_number: null, position: null, join_date: null,
};

/** Layer `over` on top of `base`, but only where `over` actually has a
 *  non-null value — a higher-priority source never erases a lower one. */
function overlay(
  base: Partial<ExtractedDocFields>,
  over: Partial<ExtractedDocFields> | null | undefined,
): Partial<ExtractedDocFields> {
  if (!over) return base;
  const out = { ...base };
  (Object.keys(over) as (keyof ExtractedDocFields)[]).forEach((k) => {
    if (over[k] != null) out[k] = over[k];
  });
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u200b-\u200f\ufeff]/g, '').trim();
  return s && s.length <= 120 && !/^null$/i.test(s) ? s : null;
}

/** Normalise any date the model / MRZ produced into YYYY-MM-DD (null when
 *  unparseable). Accepts 1990-06-12, 12/06/1990, 12-06-90, "12 JUN 1990". */
export function normaliseDate(input: unknown): string | null {
  const s = clean(input);
  if (!s) return null;
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = Number(y) > 40 ? `19${y}` : `20${y}`;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})$/.exec(s);
  if (m) {
    const mo = months[m[2].slice(0, 3).toLowerCase()];
    let y = m[3];
    if (y.length === 2) y = Number(y) > 40 ? `19${y}` : `20${y}`;
    if (mo) return `${y}-${mo}-${m[1].padStart(2, '0')}`;
  }
  m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = months[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

/** MRZ YYMMDD → YYYY-MM-DD. `future=true` (expiry dates) assumes 20xx. */
function mrzDate(yy: string, mm: string, dd: string, future = false): string | null {
  if (!/^\d{2}$/.test(yy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) return null;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  const century = future ? '20' : (Number(yy) > 30 ? '19' : '20');
  return `${century}${yy}-${mm}-${dd}`;
}

/** Map "IND", "INDIAN", "India" → the matching option from the nationality
 *  list (null when nothing matches confidently). */
export function normaliseNationality(input: unknown): string | null {
  const raw = clean(input);
  if (!raw) return null;
  const needle = raw.toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (!needle) return null;
  // exact / prefix ("uae" → United Arab Emirates via alias table)
  const aliases: Record<string, string> = {
    uae: 'United Arab Emirates', 'u.a.e': 'United Arab Emirates',
    uk: 'United Kingdom', britain: 'United Kingdom',
    usa: 'United States', us: 'United States',
  };
  if (aliases[needle]) return aliases[needle];
  const exact = COUNTRIES.find((c) => c.toLowerCase() === needle);
  if (exact) return exact;
  const starts = COUNTRIES.find((c) => c.toLowerCase().startsWith(needle));
  if (starts && needle.length >= 4) return starts;
  // ISO-3166 alpha-3 → common workforce countries
  const alpha3: Record<string, string> = {
    IND: 'India', PAK: 'Pakistan', BGD: 'Bangladesh', NPL: 'Nepal', LKA: 'Sri Lanka',
    PHL: 'Philippines', IDN: 'Indonesia', EGY: 'Egypt', SDN: 'Sudan', SSD: 'Sudan',
    ETH: 'Ethiopia', ERI: 'Eritrea', KEN: 'Kenya', NGA: 'Nigeria', GHA: 'Ghana',
    UGA: 'Uganda', TZA: 'Tanzania', ZMB: 'Zambia', ZWE: 'Zimbabwe', MWI: 'Malawi',
    MAR: 'Morocco', TUN: 'Tunisia', DZA: 'Algeria', JOR: 'Jordan', SYR: 'Syria',
    LBN: 'Lebanon', IRQ: 'Iraq', IRN: 'Iran', YEM: 'Yemen', OMN: 'Oman',
    KWT: 'Kuwait', QAT: 'Qatar', SAU: 'Saudi Arabia', ARE: 'United Arab Emirates',
    AFG: 'Afghanistan', CHN: 'China', VNM: 'Vietnam', THA: 'Thailand', MYS: 'Malaysia',
    MDV: 'Maldives', UZB: 'Uzbekistan', RWA: 'Rwanda', SEN: 'Senegal',
    MLI: 'Mali', NER: 'Niger', SLE: 'Sierra Leone', SOM: 'Somalia',
    BFA: 'Burkina Faso', CIV: 'Ivory Coast', CMR: 'Cameroon',
  };
  const byCode = alpha3[needle.toUpperCase()];
  if (byCode) return byCode;
  return null;
}

// ---------------------------------------------------------------------------
// PDF text (pdf.js — same setup as the in-app viewer / Pebby reader)
// ---------------------------------------------------------------------------
async function extractPdfText(file: File, maxPages = 3): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= Math.min(pdf.numPages, maxPages); p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines: string[] = [];
    let line = '';
    for (const item of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue;
      line += item.str;
      if (item.hasEOL) {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
    }
    if (line.trim()) lines.push(line.trim());
    if (lines.length) parts.push(lines.join('\n'));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// MRZ parsing (TD3 passport, TD1 visa / ID card) — deterministic, offline
// ---------------------------------------------------------------------------
interface MrzFields {
  full_name: string | null;
  nationality: string | null;
  date_of_birth: string | null;
  passport_number: string | null;
  passport_expiry: string | null;
  id_number: string | null;
}

const mrzLine = (s: string): string => s.replace(/\s/g, '').toUpperCase();

/** UAE Emirates ID number: 784 + birth year + 7 digits + check digit (15
 *  digits, printed 784-YYYY-NNNNNNN-C). Normalised to the dashed form. */
export function normaliseEmiratesId(input: unknown): string | null {
  const s = clean(input);
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length !== 15 || !digits.startsWith('784')) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 14)}-${digits.slice(14)}`;
}

/** Sweep raw document text for a printed Emirates ID number (labelled or
 *  not) — UAE IDs always start with 784. */
function emiratesIdFromText(text: string): string | null {
  const m = /\b784[-\s–]?\d{4}[-\s–]?\d{7}[-\s–]?\d\b/.exec(text)
    ?? /\b(784\d{12})\b/.exec(text);
  return m ? normaliseEmiratesId(m[0] ?? m[1]) : null;
}

/** TD3 (passport): two 44-char lines. */
function parseTd3(l1: string, l2: string): MrzFields | null {
  if (l1.length < 88 && l1.length !== 44) return null;
  if (!/^P</.test(l1) || l2.length < 40) return null;
  const namePart = l1.slice(5);
  const [surname, given] = namePart.split('<<');
  const pretty = (s: string): string => s.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
  return {
    full_name: [pretty(given ?? ''), pretty(surname ?? '')].filter(Boolean).join(' ') || null,
    nationality: normaliseNationality(l2.slice(10, 13)) ?? null,
    date_of_birth: mrzDate(l2.slice(13, 15), l2.slice(15, 17), l2.slice(17, 19)) ?? null,
    passport_number: l2.slice(0, 9).replace(/</g, '') || null,
    // TD3 line 2 positions 20–25 (after sex at 19)
    passport_expiry: mrzDate(l2.slice(20, 22), l2.slice(22, 24), l2.slice(24, 26), true) ?? null,
    id_number: null,
  };
}

/** TD1 (visa / ID card): three 30-char lines. Doc codes "I<" / "ID<" (ID
 *  cards incl. the UAE Emirates ID), "A<"/"AC<" (visas), "V<". */
function parseTd1(l1: string, l2: string, l3: string): MrzFields | null {
  if (!/^[ACIV][A-Z0-9]?</.test(l1) || l2.length < 28) return null;
  const namePart = l3;
  const [surname, given] = namePart.split('<<');
  const pretty = (s: string): string => s.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
  // UAE Emirates ID: line 1 = I<ARE + the 15-digit ID (784-YYYY-NNNNNNN-C)
  // laid across the standard document-number + optional fields — read it as a
  // whole instead of the generic slices.
  const eid = /^I<?[A-Z]{3}(784\d{12})/.exec(l1) ? normaliseEmiratesId(l1.slice(5, 20)) : null;
  return {
    full_name: [pretty(given ?? ''), pretty(surname ?? '')].filter(Boolean).join(' ') || null,
    nationality: normaliseNationality(l2.slice(15, 18)) ?? null,
    date_of_birth: mrzDate(l2.slice(0, 2), l2.slice(2, 4), l2.slice(4, 6)) ?? null,
    passport_number: eid ? null : (l1.slice(5, 14).replace(/</g, '') || null),
    passport_expiry: mrzDate(l2.slice(8, 10), l2.slice(10, 12), l2.slice(12, 14), true) ?? null,
    id_number: eid ?? (l1.slice(15, 30).replace(/</g, '') || null),
  };
}

/** Scan extracted text for an MRZ block. */
function parseMrz(text: string): MrzFields | null {
  const lines = text
    .split(/\n|\r/)
    .map((l) => mrzLine(l))
    .filter((l) => l.length >= 28 && /^[A-Z0-9<]+$/.test(l) && /</.test(l));
  // TD3: two consecutive 44-char lines
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].length === 44 && lines[i + 1].length === 44) {
      const parsed = parseTd3(lines[i], lines[i + 1]);
      if (parsed) return parsed;
    }
  }
  // TD1: three consecutive 30-char lines
  for (let i = 0; i + 2 < lines.length; i++) {
    if (lines[i].length === 30 && lines[i + 1].length === 30 && lines[i + 2].length === 30) {
      const parsed = parseTd1(lines[i], lines[i + 1], lines[i + 2]);
      if (parsed) return parsed;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Labelled-regex fallback (PDF text without an MRZ block)
// ---------------------------------------------------------------------------
function parseLabeledText(text: string): Partial<ExtractedDocFields> {
  const out: Partial<ExtractedDocFields> = {};
  const grab = (labels: string[]): string | null => {
    for (const label of labels) {
      const re = new RegExp(`${label}\\s*[:\\-]?\\s*([A-Za-z][A-Za-z .'/-]{1,60}|[A-Z0-9-]{4,20})`, 'i');
      const m = re.exec(text);
      if (m) {
        const v = m[1].trim();
        if (v.length >= 2) return v;
      }
    }
    return null;
  };
  const name = grab(['name', 'full name', 'surname/given names', 'given names', 'holder name']);
  if (name && name.length >= 3) out.full_name = name.replace(/\s+/g, ' ');
  const nat = grab(['nationality', 'nationality/citizenship']);
  if (nat) out.nationality = normaliseNationality(nat.split(/[\s/]/)[0]);
  const dob = grab(['date of birth', 'd\\.?o\\.?b', 'birth date']);
  if (dob) out.date_of_birth = normaliseDate(dob);
  const pp = grab(['passport no', 'passport number', 'document no', 'document number']);
  if (pp) out.passport_number = pp.toUpperCase().replace(/[^A-Z0-9/-]/g, '');
  const exp = grab(['date of expiry', 'expiry date', 'date of expiration', 'valid until']);
  if (exp) out.passport_expiry = normaliseDate(exp);
  const pos = grab(['occupation', 'profession', 'position', 'job title']);
  if (pos) out.position = pos.replace(/\s+/g, ' ');
  const joined = grab(['start date', 'joining date', 'join date', 'commencement date', 'employment date']);
  if (joined) out.join_date = normaliseDate(joined);
  const idn = grab(['emirates id', 'id no', 'id number', 'identity no', 'unified no']);
  if (idn) out.id_number = idn.toUpperCase().replace(/[^A-Z0-9/-]/g, '');
  if (!out.id_number) out.id_number = emiratesIdFromText(text);
  return out;
}

// ---------------------------------------------------------------------------
// AI round (text or vision) through the same /api/ai proxy Pebby uses
// ---------------------------------------------------------------------------
const EXTRACT_SYSTEM_PROMPT = [
  'You extract structured fields from workforce identity documents (passports, visas / residence permits, UAE Emirates ID cards, employment contracts).',
  'Reply with ONLY a minified JSON object, no markdown, no explanations, with exactly these keys:',
  'full_name, nationality, date_of_birth, passport_number, passport_expiry, id_number, position, join_date.',
  'Rules: dates as YYYY-MM-DD; nationality as the country name in English; position = job title/occupation as printed;',
  'id_number = the Emirates ID number when the document is an Emirates ID card or shows one (784-YYYY-NNNNNNN-C, keep the dashes);',
  'join_date = contract start date when the document is a contract.',
  'Use null for EVERY value you cannot read confidently. NEVER invent or guess values.',
].join(' ');

function parseModelJson(reply: string): Partial<ExtractedDocFields> | null {
  let text = reply.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return {
      full_name: clean(raw.full_name),
      nationality: normaliseNationality(raw.nationality),
      date_of_birth: normaliseDate(raw.date_of_birth),
      passport_number: clean(raw.passport_number)?.toUpperCase().replace(/[^A-Z0-9/-]/g, '') ?? null,
      passport_expiry: normaliseDate(raw.passport_expiry),
      id_number: normaliseEmiratesId(raw.id_number) ?? (clean(raw.id_number)?.toUpperCase().replace(/[^A-Z0-9/-]/g, '') ?? null),
      position: clean(raw.position),
      join_date: normaliseDate(raw.join_date),
    };
  } catch {
    return null;
  }
}

async function callAi(
  ai: DocExtractAiOptions,
  userContent: unknown,
  headers: Record<string, string>,
): Promise<string> {
  const body: Record<string, unknown> = {
    action: 'chat',
    baseUrl: ai.baseUrl,
    model: ai.model,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    maxTokens: 600,
    temperature: 0,
  };
  if (ai.apiKey) body.apiKey = ai.apiKey;
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let json: { ok?: boolean; reply?: string; error?: string } | null = null;
  try {
    json = await res.json() as { ok?: boolean; reply?: string; error?: string } | null;
  } catch {
    json = null;
  }
  if (!json) throw new Error('The AI service returned an unreadable response.');
  if (!json.ok || typeof json.reply !== 'string') {
    throw new Error(json.error || 'The AI provider could not read the document.');
  }
  return json.reply;
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/** Read a File → form fields. Never throws for "unreadable" documents — the
 *  result carries a note instead; only true network/storage failures throw. */
export async function extractDocumentFields(
  file: File,
  ai: DocExtractAiOptions,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): Promise<DocExtractResult> {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name.trim())?.[1] ?? '').toLowerCase();
  const isPdf = file.type === 'application/pdf' || ext === 'pdf';
  const isImage = file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
  if (!isPdf && !isImage) {
    return { fields: { ...EMPTY }, source: 'none', note: 'Only PDF and image files can be read automatically.' };
  }

  // ---- PDF: local text → MRZ / labels (+ AI polish when configured) --------
  if (isPdf) {
    let text = '';
    try {
      text = await extractPdfText(file);
    } catch {
      text = '';
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        fields: { ...EMPTY },
        source: 'none',
        note: 'The PDF has no text layer (it is a scan). Save it as an image or configure the AI connection to read scans.',
      };
    }
    // deterministic MRZ first — passports almost always carry one
    const mrz = parseMrz(trimmed);
    const labeled = parseLabeledText(trimmed);
    if (!ai.enabled) {
      // deterministic MRZ first — passports almost always carry one; the
      // labeled-regex fallback only fills what the MRZ lacks
      const merged: ExtractedDocFields = {
        ...EMPTY,
        ...overlay(labeled, mrz),
        nationality: mrz?.nationality ?? labeled.nationality ?? null,
      };
      const found = Object.values(merged).some(Boolean);
      return {
        fields: merged,
        source: mrz ? 'mrz' : 'none',
        note: found
          ? (mrz ? 'Read from the passport MRZ (offline).' : undefined)
          : 'No AI connection configured — could not recognise fields in this text. Configure the AI Bot in Site Settings for smarter reading.',
      };
    }
    // AI round with the raw text
    try {
      const reply = await callAi(
        ai,
        `Document text extracted from "${file.name}" (a ${ext.toUpperCase()}):\n\n${trimmed.slice(0, 8000)}`,
        headers,
      );
      const fromAi = parseModelJson(reply);
      if (fromAi) {
        // priority: MRZ (deterministic) > AI > labeled fallback
        return {
          fields: {
            ...EMPTY,
            ...overlay(overlay(labeled, fromAi), mrz),
            nationality: mrz?.nationality ?? fromAi.nationality ?? labeled.nationality ?? null,
          },
          source: 'ai-text',
        };
      }
    } catch {
      // fall through to the deterministic result
    }
    const merged: ExtractedDocFields = {
      ...EMPTY,
      ...overlay(labeled, mrz),
      nationality: mrz?.nationality ?? labeled.nationality ?? null,
    };
    return { fields: merged, source: mrz ? 'mrz' : 'none', note: mrz ? undefined : 'The AI could not parse the text — filled what the offline reader recognised.' };
  }

  // ---- IMAGE: AI vision only ------------------------------------------------
  if (!ai.enabled) {
    return {
      fields: { ...EMPTY },
      source: 'none',
      note: 'Reading images needs the AI connection — ask a super admin to configure it in Site Settings (a vision-capable model, e.g. gpt-4o-mini).',
    };
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  try {
    const reply = await callAi(
      ai,
      [
        { type: 'text', text: `Read this scanned document ("${file.name}") and extract its fields.` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
      headers,
    );
    const fromAi = parseModelJson(reply);
    if (fromAi) return { fields: { ...EMPTY, ...fromAi }, source: 'ai-vision' };
    return { fields: { ...EMPTY }, source: 'none', note: 'The AI could not recognise fields in this image — please type them manually.' };
  } catch (err) {
    return {
      fields: { ...EMPTY },
      source: 'none',
      note: err instanceof Error ? err.message : 'The AI could not read this image.',
    };
  }
}

/** Passport status derived from an expiry date (null = leave untouched). */
export function passportStatusFromExpiry(expiry: string | null): 'Valid' | 'Expired' | null {
  if (!expiry) return null;
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d >= today ? 'Valid' : 'Expired';
}
