// ============================================================================
// PULSE Workforce OS — Nationality regions & country groups
// ----------------------------------------------------------------------------
// Used by the Employees page filter: pick a REGION (Africans, Asians, Arabs,
// Europeans, Latin Americans…) and then a specific COUNTRY within it
// (e.g. Burundi inside Africans, India inside Asians).
// Any nationality not listed below falls into the "Others" bucket so no
// employee is ever un-filterable.
// ============================================================================

export interface NationalityRegion {
  key: string;
  label: string;
  countries: string[];
}

export const NATIONALITY_REGIONS: NationalityRegion[] = [
  {
    key: 'africans',
    label: 'Africans',
    countries: [
      'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi',
      'Cameroon', 'Cape Verde', 'Central African Republic', 'Chad', 'Comoros',
      'Congo', 'DR Congo', 'Djibouti', 'Egypt', 'Equatorial Guinea', 'Eritrea',
      'Eswatini', 'Ethiopia', 'Gabon', 'Gambia', 'Ghana', 'Guinea',
      'Guinea-Bissau', 'Ivory Coast', 'Kenya', 'Lesotho', 'Liberia', 'Libya',
      'Madagascar', 'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco',
      'Mozambique', 'Namibia', 'Niger', 'Nigeria', 'Rwanda', 'Senegal',
      'Seychelles', 'Sierra Leone', 'Somalia', 'South Africa', 'South Sudan',
      'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe',
    ],
  },
  {
    key: 'asians',
    label: 'Asians',
    countries: [
      'Afghanistan', 'Bangladesh', 'Bhutan', 'Brunei', 'Cambodia', 'China',
      'East Timor', 'Hong Kong', 'India', 'Indonesia', 'Japan', 'Kazakhstan',
      'Kyrgyzstan', 'Laos', 'Malaysia', 'Maldives', 'Mongolia', 'Myanmar',
      'Nepal', 'North Korea', 'Pakistan', 'Philippines', 'Singapore',
      'South Korea', 'Sri Lanka', 'Taiwan', 'Tajikistan', 'Thailand',
      'Turkmenistan', 'Uzbekistan', 'Vietnam',
    ],
  },
  {
    key: 'arabs',
    label: 'Arabs / Middle East',
    countries: [
      'Bahrain', 'Iraq', 'Jordan', 'Kuwait', 'Lebanon', 'Oman', 'Palestine',
      'Qatar', 'Saudi Arabia', 'Syria', 'United Arab Emirates', 'Yemen',
    ],
  },
  {
    key: 'europeans',
    label: 'Europeans',
    countries: [
      'Albania', 'Armenia', 'Austria', 'Azerbaijan', 'Belarus', 'Belgium',
      'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia',
      'Denmark', 'Estonia', 'Finland', 'France', 'Georgia', 'Germany',
      'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy', 'Latvia',
      'Lithuania', 'Luxembourg', 'Malta', 'Moldova', 'Montenegro',
      'Netherlands', 'North Macedonia', 'Norway', 'Poland', 'Portugal',
      'Romania', 'Russia', 'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden',
      'Switzerland', 'Turkey', 'Ukraine', 'United Kingdom', 'Uzbekistan',
    ],
  },
  {
    key: 'latin-americans',
    label: 'Latin Americans',
    countries: [
      'Argentina', 'Bolivia', 'Brazil', 'Chile', 'Colombia', 'Costa Rica',
      'Cuba', 'Dominican Republic', 'Ecuador', 'El Salvador', 'Guatemala',
      'Haiti', 'Honduras', 'Mexico', 'Nicaragua', 'Panama', 'Paraguay', 'Peru',
      'Uruguay', 'Venezuela',
    ],
  },
];

export const ALL_REGION_COUNTRIES: Set<string> = new Set(
  NATIONALITY_REGIONS.flatMap((r) => r.countries),
);

/** Region label for a nationality (e.g. "India" → "Asians"); "Others" when unknown. */
export function regionOfNationality(nationality: string | null | undefined): string {
  if (!nationality) return 'Others';
  const n = nationality.trim().toLowerCase();
  if (!n) return 'Others';
  for (const region of NATIONALITY_REGIONS) {
    if (region.countries.some((c) => c.toLowerCase() === n)) return region.label;
  }
  return 'Others';
}

/** Countries actually present among `nationalities`, grouped under their region. */
export function countriesByRegion(
  nationalities: (string | null | undefined)[],
): Record<string, string[]> {
  const present = [...new Set(nationalities.filter((n): n is string => !!n?.trim()))]
    .sort((a, b) => a.localeCompare(b));
  const map: Record<string, string[]> = { Others: [] };
  NATIONALITY_REGIONS.forEach((r) => { map[r.label] = []; });
  present.forEach((n) => {
    const region = regionOfNationality(n);
    (map[region] ??= []).push(n);
  });
  Object.keys(map).forEach((k) => {
    if (map[k].length === 0) delete map[k];
  });
  return map;
}
