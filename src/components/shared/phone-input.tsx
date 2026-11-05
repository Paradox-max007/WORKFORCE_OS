'use client';

// ============================================================================
// PULSE Workforce OS — Phone input with a country-code dropdown
// ----------------------------------------------------------------------------
// A country select (+971, +966, +91 …) next to the local number field. The
// stored value keeps the legacy free-text format "+<dial> <number>" so every
// existing record (and the whole data layer) stays compatible:
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
  name: string;
  dial: string;
}

/** Workforce-relevant countries (mirrors the Nationality list) + common others */
const PHONE_COUNTRIES: PhoneCountry[] = [
  { iso: 'AE', name: 'United Arab Emirates', dial: '971' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966' },
  { iso: 'IN', name: 'India', dial: '91' },
  { iso: 'PK', name: 'Pakistan', dial: '92' },
  { iso: 'BD', name: 'Bangladesh', dial: '880' },
  { iso: 'NP', name: 'Nepal', dial: '977' },
  { iso: 'LK', name: 'Sri Lanka', dial: '94' },
  { iso: 'PH', name: 'Philippines', dial: '63' },
  { iso: 'EG', name: 'Egypt', dial: '20' },
  { iso: 'SD', name: 'Sudan', dial: '249' },
  { iso: 'ET', name: 'Ethiopia', dial: '251' },
  { iso: 'ER', name: 'Eritrea', dial: '291' },
  { iso: 'KE', name: 'Kenya', dial: '254' },
  { iso: 'UG', name: 'Uganda', dial: '256' },
  { iso: 'TZ', name: 'Tanzania', dial: '255' },
  { iso: 'RW', name: 'Rwanda', dial: '250' },
  { iso: 'NG', name: 'Nigeria', dial: '234' },
  { iso: 'GH', name: 'Ghana', dial: '233' },
  { iso: 'SN', name: 'Senegal', dial: '221' },
  { iso: 'SL', name: 'Sierra Leone', dial: '232' },
  { iso: 'ML', name: 'Mali', dial: '223' },
  { iso: 'NE', name: 'Niger', dial: '227' },
  { iso: 'SO', name: 'Somalia', dial: '252' },
  { iso: 'ZM', name: 'Zambia', dial: '260' },
  { iso: 'ZW', name: 'Zimbabwe', dial: '263' },
  { iso: 'MW', name: 'Malawi', dial: '265' },
  { iso: 'MG', name: 'Madagascar', dial: '261' },
  { iso: 'AF', name: 'Afghanistan', dial: '93' },
  { iso: 'IR', name: 'Iran', dial: '98' },
  { iso: 'IQ', name: 'Iraq', dial: '964' },
  { iso: 'JO', name: 'Jordan', dial: '962' },
  { iso: 'LB', name: 'Lebanon', dial: '961' },
  { iso: 'SY', name: 'Syria', dial: '963' },
  { iso: 'PS', name: 'Palestine', dial: '970' },
  { iso: 'YE', name: 'Yemen', dial: '967' },
  { iso: 'OM', name: 'Oman', dial: '968' },
  { iso: 'KW', name: 'Kuwait', dial: '965' },
  { iso: 'QA', name: 'Qatar', dial: '974' },
  { iso: 'BH', name: 'Bahrain', dial: '973' },
  { iso: 'MY', name: 'Malaysia', dial: '60' },
  { iso: 'ID', name: 'Indonesia', dial: '62' },
  { iso: 'SG', name: 'Singapore', dial: '65' },
  { iso: 'TH', name: 'Thailand', dial: '66' },
  { iso: 'VN', name: 'Vietnam', dial: '84' },
  { iso: 'KH', name: 'Cambodia', dial: '855' },
  { iso: 'LA', name: 'Laos', dial: '856' },
  { iso: 'MM', name: 'Myanmar', dial: '95' },
  { iso: 'BN', name: 'Brunei', dial: '673' },
  { iso: 'CN', name: 'China', dial: '86' },
  { iso: 'HK', name: 'Hong Kong', dial: '852' },
  { iso: 'BT', name: 'Bhutan', dial: '975' },
  { iso: 'MV', name: 'Maldives', dial: '960' },
  { iso: 'MR', name: 'Mauritania', dial: '222' },
  { iso: 'MA', name: 'Morocco', dial: '212' },
  { iso: 'TN', name: 'Tunisia', dial: '216' },
  { iso: 'UZ', name: 'Uzbekistan', dial: '998' },
  { iso: 'TR', name: 'Turkey', dial: '90' },
  { iso: 'US', name: 'United States / Canada', dial: '1' },
  { iso: 'GB', name: 'United Kingdom', dial: '44' },
  { iso: 'IE', name: 'Ireland', dial: '353' },
  { iso: 'DE', name: 'Germany', dial: '49' },
  { iso: 'FR', name: 'France', dial: '33' },
  { iso: 'IT', name: 'Italy', dial: '39' },
  { iso: 'ES', name: 'Spain', dial: '34' },
  { iso: 'PT', name: 'Portugal', dial: '351' },
  { iso: 'NL', name: 'Netherlands', dial: '31' },
  { iso: 'PL', name: 'Poland', dial: '48' },
  { iso: 'RO', name: 'Romania', dial: '40' },
  { iso: 'UA', name: 'Ukraine', dial: '380' },
  { iso: 'RU', name: 'Russia / Kazakhstan', dial: '7' },
  { iso: 'AU', name: 'Australia', dial: '61' },
  { iso: 'NZ', name: 'New Zealand', dial: '64' },
  { iso: 'BR', name: 'Brazil', dial: '55' },
  { iso: 'ZA', name: 'South Africa', dial: '27' },
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
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
  ariaLabel?: string;
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
        <SelectTrigger className="h-11 w-[150px] shrink-0 bg-card font-mono text-xs" aria-label="Phone country code">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value={OTHER} className="font-mono">+? Other</SelectItem>
          {PHONE_COUNTRIES.map((c) => (
            <SelectItem key={c.iso} value={c.iso}>
              <span className="font-mono text-xs">+{c.dial}</span>
              {' · '}
              <span className="text-xs">{c.name}</span>
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
