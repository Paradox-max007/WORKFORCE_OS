'use client';

// ============================================================================
// PULSE Workforce OS — Employee search (Working Hours module)
// ----------------------------------------------------------------------------
// Searchable dropdown that finds employees by name, employee ID, trade,
// nationality or CURRENT SITE, and shows each candidate's site so the picker
// can confirm they picked the right person before loading their report.
// ============================================================================

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronsUpDown, Crown, Loader2, MapPin, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { EmployeeVM } from '@/lib/types';

export function EmployeeSearch({
  employees,
  value,
  onChange,
  loading,
}: {
  employees: EmployeeVM[];
  value: string | null;
  onChange: (employeeId: string | null) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = useMemo(() => employees.find((e) => e.id === value) ?? null, [employees, value]);

  const q = query.toLowerCase().trim();
  const filtered = useMemo(() => {
    if (!q) return employees;
    return employees.filter((e) =>
      `${e.full_name} ${e.employee_code} ${e.position ?? ''} ${e.nationality ?? ''} ${e.site_name ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [employees, q]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={loading}
          className="h-12 w-full justify-between font-normal"
        >
          {loading && !employees.length ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading employees…
            </span>
          ) : selected ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                {selected.photo ? (
                  <img src={selected.photo} alt={selected.full_name} className="size-full object-cover" />
                ) : (
                  initials(selected.full_name)
                )}
              </span>
              <span className="min-w-0 truncate text-left">
                <span className="block truncate leading-tight">{selected.full_name}</span>
                <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                  {selected.employee_code} · {selected.site_name ?? 'Idle'}
                </span>
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Search size={14} className="shrink-0" />
              Search employee name, ID, trade or site…
            </span>
          )}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popper-anchor-width) p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search by name, ID, trade, nationality or site…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="overscroll-contain">
            <CommandEmpty>No employees found.</CommandEmpty>
            <CommandGroup>
              {filtered.map((e) => (
                <CommandItem
                  key={e.id}
                  value={`${e.full_name} ${e.employee_code} ${e.position ?? ''} ${e.site_name ?? ''}`}
                  onSelect={() => {
                    onChange(e.id);
                    setOpen(false);
                  }}
                  className={cn(value === e.id && 'bg-brand/10')}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                    {e.photo ? (
                      <img src={e.photo} alt={e.full_name} className="size-full object-cover" />
                    ) : (
                      initials(e.full_name)
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate text-sm">
                      {e.full_name}
                      {e.is_team_leader && <Crown size={11} className="shrink-0 fill-amber-400 text-amber-400" />}
                      {e.status === 'pending_deletion' && (
                        <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 text-[9px] font-semibold text-amber-500">
                          pending removal
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {e.employee_code} · {e.position ?? 'No position'}
                    </span>
                  </span>
                  {e.site_name ? (
                    <span className="ml-2 inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                      <MapPin size={10} />
                      {e.site_name}
                    </span>
                  ) : (
                    <span className="ml-2 shrink-0 text-[10px] text-amber-500">Idle</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
