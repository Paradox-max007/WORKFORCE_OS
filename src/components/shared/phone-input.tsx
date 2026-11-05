'use client';

// ============================================================================
// PULSE Workforce OS — Phone input with a country-code dropdown
// ----------------------------------------------------------------------------
// A dial-code select (+971, +966, +91 …) next to the local number field. The
// dropdown lists ONLY the codes (no country names) and is curated for this
// workforce — African and Asian countries first (Gulf, South Asia,
// South-East Asia, Africa), with just a couple of common extras at the end.
//
// The stored value keeps the legacy free-text format "+<dial> <number>" so
// every existing record (and the whole data layer) stays compatible:
//
//   • existing values are parsed back into (country, local number) on load —
//     longest dial-code prefix wins (+971 before +97 before +9)
//   • values that match no known dial code fall back to an "Other" option and
//     are passed through unchanged
//   • an empty local number stores null (nothing is saved for a bare code)
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface PhoneCountry {
  iso: string;
  dial: string;
}

/** Workforce-relevant dial codes — mostly African & Asian countries.
 *  Order = the dropdown order (Gulf first, then South Asia, South-East &
 *  other Asia, Africa, then a couple of common extras). */
const PHONE_COUNTRIES: PhoneCountry[] = [
  // Gulf & Middle East
  { iso: 'AE', dial: '971' }, { iso: 'SA', dial: '966' }, { iso: 'OM', dial: '968' },
  { iso: 'KW', dial: '965' }, { iso: 'QA', dial: '974' }, { iso: 'BH', dial: '973' },
  { iso: 'YE', dial: '967' }, { iso: 'IQ', dial: '964' }, { iso: 'JO', dial: '962' },
  { iso: 'LB', dial: '961' }, { iso: 'SY', dial: '963' }, { iso: 'PS', dial: '970' },
  { iso: 'IR', dial: '98' }, { iso: 'TR', dial: '90' },
  // South Asia
  { iso: 'IN', dial: '91' }, { iso: 'PK', dial: '92' }, { iso: 'BD', dial: '880' },
  { iso: 'NP', dial: '977' }, { iso: 'LK', dial: '94' }, { iso: 'AF', dial: '93' },
  { iso: 'MV', dial: '960' }, { iso: 'BT', dial: '975' },
  // South-East Asia
  { iso: 'PH', dial: '63' }, { iso: 'ID', dial: '62' }, { iso: 'MY', dial: '60' },
  { iso: 'TH', dial: '66' }, { iso: 'VN', dial: '84' }, { iso: 'KH', dial: '855' },
  { iso: 'LA', dial: '856' }, { iso: 'MM', dial: '95' }, { iso: 'SG', dial: '65' },
  { iso: 'BN', dial: '673' },
  // Other Asia
  { iso: 'CN', dial: '86' }, { iso: 'HK', dial: '852' }, { iso: 'UZ', dial: '998' },
  { iso: 'KZ', dial: '7' }, { iso: 'MN', dial: '976' },
  // East & Horn of Africa
  { iso: 'EG', dial: '20' }, { iso: 'SD', dial: '249' }, { iso: 'SS', dial: '211' },
  { iso: 'ET', dial: '251' }, { iso: 'ER', dial: '291' }, { iso: 'SO', dial: '252' },
  { iso: 'DJ', dial: '253' }, { iso: 'KE', dial: '254' }, { iso: 'UG', dial: '256' },
  { iso: 'TZ', dial: '255' }, { iso: 'RW', dial: '250' }, { iso: 'BI', dial: '257' },
  // Central Africa
  { iso: 'CD', dial: '243' }, { iso: 'CG', dial: '242' }, { iso: 'CM', dial: '237' },
  { iso: 'CF', dial: '236' }, { iso: 'GA', dial: '241' }, { iso: 'TD', dial: '235' },
  { iso: 'GQ', dial: '240' }, { iso: 'ST', dial: '239' },
  // West Africa
  { iso: 'NG', dial: '234' }, { iso: 'GH', dial: '233' }, { iso: 'CI', dial: '225' },
  { iso: 'SN', dial: '221' }, { iso: 'ML', dial: '223' }, { iso: 'NE', dial: '227' },
  { iso: 'BF', dial: '226' }, { iso: 'GN', dial: '224' }, { iso: 'SL', dial: '232' },
  { iso: 'LR', dial: '231' }, { iso: 'TG', dial: '228' }, { iso: 'BJ', dial: '229' },
  { iso: 'GM', dial: '220' }, { iso: 'GW', dial: '245' }, { iso: 'CV', dial: '238' },
  { iso: 'MR', dial: '222' },
  // Southern Africa
  { iso: 'ZM', dial: '260' }, { iso: 'ZW', dial: '263' }, { iso: 'MW', dial: '265' },
  { iso: 'MZ', dial: '258' }, { iso: 'MG', dial: '261' }, { iso: 'MU', dial: '230' },
  { iso: 'AO', dial: '244' }, { iso: 'NA', dial: '264' }, { iso: 'BW', dial: '267' },
  { iso: 'LS', dial: '266' }, { iso: 'SZ', dial: '268' }, { iso: 'ZA', dial: '27' },
  // North Africa
  { iso: 'MA', dial: '212' }, { iso: 'DZ', dial: '213' }, { iso: 'TN', dial: '216' },
  { iso: 'LY', dial: '218' },
  // common extras
  { iso: 'US', dial: '1' }, { iso: 'GB', dial: '44' },
];

const OTHER = '__other__';
/** default when nothing is stored yet (matches the legacy placeholder style) */
const DEFAULT_ISO = 'SA';

/** longest dial-code prefix match — "+971 50 123" → (AE, "50 123") */
const parsePhone = (value: string | null): { country: PhoneCountry | null; rest: string } => {
  if (!value) return { country: null, rest: '' };
  const v = value.trim();
  if (!v.startsWith('+')) return { country: null, rest: v };
  const candidates = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of candidates) {
    if (v.startsWith(`+${c.dial}`)) {
      return { country: c, rest: v.slice(1 + c.dial.length).replace(/^[\s-]+/, '') };
    }
  }
  return { country: null, rest: v };
};

export function PhoneInput({
  value,
  onChange,
  placeholder = '5xx xxx xxxx',
  ariaLabel = 'Phone number',
  codeAriaLabel = 'Phone country code',
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** aria-label of the dial-code select (distinguish multiple PhoneInputs) */
  codeAriaLabel?: string;
}) {
  const parsed = useMemo(() => parsePhone(value), [value]);
  const [iso, setIso] = useState<string>(parsed.country?.iso ?? (value ? OTHER : DEFAULT_ISO));
  const [rest, setRest] = useState(parsed.rest);

  // adopt external value changes (employee loaded, form reset …). While the
  // local number is empty the user's chosen country code is kept.
  useEffect(() => {
    if (value == null || value.trim() === '') {
      setRest('');
      return;
    }
    setIso(parsed.country?.iso ?? OTHER);
    setRest(parsed.rest);
  }, [value, parsed.country, parsed.rest]);

  const emit = (nextIso: string, nextRest: string): void => {
    const c = PHONE_COUNTRIES.find((x) => x.iso === nextIso);
    const trimmed = nextRest.trim();
    if (!c) {
      // "Other": pass the raw text through unchanged (legacy formats)
      onChange(trimmed || null);
      return;
    }
    onChange(trimmed ? `+${c.dial} ${trimmed}` : null);
  };

  return (
    <div className="flex gap-2">
      <Select
        value={iso}
        onValueChange={(v) => {
          setIso(v);
          emit(v, rest);
        }}
      >
        <SelectTrigger className="h-11 w-24 shrink-0 bg-card font-mono text-sm" aria-label={codeAriaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value={OTHER} className="font-mono">Other</SelectItem>
          {PHONE_COUNTRIES.map((c) => (
            <SelectItem key={c.iso} value={c.iso} className="font-mono">
              +{c.dial}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={rest}
        onChange={(e) => {
          setRest(e.target.value);
          emit(iso, e.target.value);
        }}
        placeholder={placeholder}
        inputMode="tel"
        className="h-11 flex-1"
        aria-label={ariaLabel}
      />
    </div>
  );
}
