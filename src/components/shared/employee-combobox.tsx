'use client';

// ============================================================================
// PULSE Workforce OS — Searchable employee combobox (reused across modules)
// ============================================================================

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronsUpDown, Crown, MapPin } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import type { EmployeeVM } from '@/lib/types';

export function EmployeeCombobox({
  employees,
  value,
  onChange,
  placeholder = 'Search employees…',
  emptyText = 'No employees found.',
  disabled = false,
}: {
  employees: EmployeeVM[];
  value: string | null;
  onChange: (employeeId: string | null) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setOpenQuery] = useState('');
  const selected = useMemo(() => employees.find((e) => e.id === value) ?? null, [employees, value]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        e.full_name.toLowerCase().includes(q) ||
        e.employee_code.toLowerCase().includes(q) ||
        (e.position ?? '').toLowerCase().includes(q) ||
        (e.nationality ?? '').toLowerCase().includes(q),
    );
  }, [employees, query]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setOpenQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-11 w-full justify-between font-normal"
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                {selected.photo ? (
                   
                  <img src={selected.photo} alt={selected.full_name} className="size-full object-cover" />
                ) : (
                  initials(selected.full_name)
                )}
              </span>
              <span className="truncate">{selected.full_name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{selected.employee_code}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popper-anchor-width) p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Type to search…"
            value={query}
            onValueChange={setOpenQuery}
          />
          <CommandList className="overscroll-contain">
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {filtered.map((e) => (
                <CommandItem
                  key={e.id}
                  value={`${e.full_name} ${e.employee_code} ${e.position ?? ''}`}
                  onSelect={() => {
                    onChange(e.id === value ? null : e.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-[10px] font-bold text-brand">
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
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
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
