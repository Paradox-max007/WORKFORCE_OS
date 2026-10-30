'use client';

// ============================================================================
// PULSE Workforce OS — Nationality searchable select with custom free-text entry
// ============================================================================

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ChevronsUpDown, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

const COUNTRIES: string[] = [
  'Afghanistan', 'Bangladesh', 'Bhutan', 'Brunei', 'Cambodia', 'China', 'Egypt',
  'Eritrea', 'Ethiopia', 'Ghana', 'India', 'Indonesia', 'Iran', 'Iraq', 'Jordan',
  'Kenya', 'Kuwait', 'Laos', 'Lebanon', 'Madagascar', 'Malawi', 'Malaysia',
  'Maldives', 'Mali', 'Mauritania', 'Morocco', 'Myanmar', 'Nepal', 'Niger',
  'Nigeria', 'Oman', 'Pakistan', 'Palestine', 'Philippines', 'Qatar', 'Rwanda',
  'Saudi Arabia', 'Senegal', 'Sierra Leone', 'Somalia', 'Sri Lanka', 'Sudan',
  'Syria', 'Tanzania', 'Thailand', 'Tunisia', 'Uganda', 'United Arab Emirates',
  'Uzbekistan', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
];

export function NationalitySelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => c.toLowerCase().includes(q));
  }, [query]);

  const isCustom = value !== null && !COUNTRIES.includes(value);

  const commit = (v: string) => {
    onChange(v || null);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" disabled={disabled} className="h-11 w-full justify-between font-normal">
          <span className={value ? '' : 'text-muted-foreground'}>
            {isCustom ? `${value} (custom)` : value ?? 'Select nationality (optional)'}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popper-anchor-width) p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type to add custom…"
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) {
                e.preventDefault();
                commit(query.trim());
              }
            }}
          />
          <CommandList className="overscroll-contain">
            <CommandEmpty>No country found — press Enter to add it as a custom entry.</CommandEmpty>
            <CommandGroup>
              {query.trim() && !filtered.some((c) => c.toLowerCase() === query.trim().toLowerCase()) && (
                <CommandItem onSelect={() => commit(query.trim())}>
                  <Plus className="mr-1 size-3.5 text-brand" />
                  Add “{query.trim()}” as custom
                </CommandItem>
              )}
              {filtered.map((c) => (
                <CommandItem key={c} value={c} onSelect={() => commit(c)}>
                  {c}
                  {value === c && <span className="ml-auto text-xs text-brand">selected</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
