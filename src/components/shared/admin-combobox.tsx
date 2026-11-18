'use client';

// ============================================================================
// PULSE Workforce OS — Searchable admin combobox (attendance marker picker)
// ----------------------------------------------------------------------------
// A searchable dropdown of every ADMIN and SUPER ADMIN account, used on the
// Sites form to assign a site's attendance marker ("supervisor"). The picked
// admin's NAME is stored on the site (Site.supervisor is a person name shown
// as "Supervised by" on attendance sheets and grouped in "View by
// Supervisors") — so a legacy free-text marker still displays fine, it just
// isn't tied to an account.
// ============================================================================

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronsUpDown, Crown, ShieldCheck, UserMinus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import type { Profile } from '@/lib/types';

export function AdminCombobox({
  admins,
  value,
  onChange,
  placeholder = 'Pick an admin…',
  emptyText = 'No matching admins.',
  disabled = false,
}: {
  /** every admin/super-admin profile (listProfiles already excludes pending) */
  admins: Profile[];
  /** the marker stored on the site — an admin NAME (or legacy free text) */
  value: string | null;
  onChange: (name: string | null) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // admin + super admin only — pending accounts can never mark attendance
  const staff = useMemo(
    () => admins.filter((p) => p.role === 'admin' || p.role === 'super_admin'),
    [admins],
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return staff;
    return staff.filter(
      (p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
    );
  }, [staff, query]);

  const selected = useMemo(
    () => staff.find((p) => p.name === value) ?? null,
    [staff, value],
  );
  const isLegacy = !!value && !selected;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-label="Attendance marker (supervisor)"
          aria-expanded={open}
          disabled={disabled}
          className="h-11 w-full justify-between font-normal"
        >
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                {initials(value)}
              </span>
              <span className="truncate">{value}</span>
              {selected && (
                <span className="ml-0.5 shrink-0 text-[10px] text-muted-foreground">
                  {selected.role === 'super_admin' ? 'Super Admin' : 'Admin'}
                </span>
              )}
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
            placeholder="Search by name or email…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="overscroll-contain">
            <CommandEmpty>{emptyText}</CommandEmpty>
            {isLegacy && (
              <CommandGroup>
                <div className="px-2 py-1.5 text-[11px] leading-tight text-muted-foreground">
                  “{value}” was typed manually — pick an admin below or clear it.
                </div>
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandItem
                value="none no marker clear"
                onSelect={() => { onChange(null); setOpen(false); }}
                className="text-muted-foreground"
              >
                <UserMinus size={15} className="shrink-0" />
                <span className="text-sm">No attendance marker</span>
              </CommandItem>
            </CommandGroup>
            <CommandGroup>
              {filtered.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.email}`}
                  onSelect={() => {
                    onChange(p.name === value ? null : p.name);
                    setOpen(false);
                  }}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[10px] font-bold text-brand">
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 truncate text-sm">
                      {p.name}
                      {p.role === 'super_admin' && <Crown size={11} className="shrink-0 fill-amber-400 text-amber-400" />}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">{p.email}</span>
                  </span>
                  <span
                    className={cn(
                      'ml-2 inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                      p.role === 'super_admin'
                        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        : 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
                    )}
                  >
                    {p.role === 'super_admin' ? <Crown size={9} /> : <ShieldCheck size={9} />}
                    {p.role === 'super_admin' ? 'Super Admin' : 'Admin'}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
