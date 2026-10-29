'use client';

// ============================================================================
// PULSE Workforce OS — Dashboard (live metrics, charts, site breakdown)
// ============================================================================

import { motion } from 'framer-motion';
import {
  Building2, CalendarDays, CheckCircle2, Clock, Crown, Eye, MapPin,
  UserX, Users, XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, SectionTitle, StatCard } from '@/components/shared/primitives';
import { dataApi } from '@/lib/data';
import { cn } from '@/lib/utils';
import type { Attendance, EmployeeVM, MonthlySummaryRow, SiteWithCount } from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useRealtimeVersion } from '@/store/realtime';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const STATUS_COLORS: Record<string, string> = {
  present: '#22c55e',
  absent: '#ef4444',
};

/** Custom readable chart tooltip (recharts' default pie tooltip renders black
 *  text on a dark tooltip in dark mode — this replaces it in both charts). */
function ChartTooltip({
  active, payload, label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string; fill?: string; payload?: { color?: string } }[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-xl">
      {label !== undefined && label !== '' && (
        <p className="mb-1 font-semibold text-foreground">{label}</p>
      )}
      <div className="space-y-1">
        {payload.map((p, i) => {
          const dot = p.color ?? p.fill ?? p.payload?.color ?? '#71717a';
          return (
            <p key={i} className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
              <span className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
              {p.name}:{' '}
              <span className="font-semibold tabular-nums text-foreground">{p.value}</span>
            </p>
          );
        })}
      </div>
    </div>
  );
}

interface DayOption {
  value: string;
  label: string;
  upcoming?: boolean;
  today?: boolean;
}

export function DashboardPage() {
  const navigateTo = useAppStore((s) => s.navigateTo);
  const navigateToEmployees = useAppStore((s) => s.navigateToEmployees);
  const realtimeVersion = useRealtimeVersion(['attendance', 'employee', 'site']);

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-indexed
  const [day, setDay] = useState(now.getDate());

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [sites, setSites] = useState<SiteWithCount[] | null>(null);
  const [attendance, setAttendance] = useState<Attendance[] | null>(null);
  const [summary, setSummary] = useState<MonthlySummaryRow[] | null>(null);

  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // ---- data loading ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [emps, sts, sum] = await Promise.all([
        dataApi.listEmployees(),
        dataApi.listSites(),
        dataApi.getMonthlyAttendanceSummary(6),
      ]);
      if (!cancelled) {
        setEmployees(emps);
        setSites(sts);
        setSummary(sum);
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
     
  }, [realtimeVersion]);

  useEffect(() => {
    let cancelled = false;
    dataApi.getMonthAttendance(monthStr)
      .then((rows) => { if (!cancelled) setAttendance(rows); })
      .catch(() => { if (!cancelled) setAttendance([]); });
    return () => { cancelled = true; };
  }, [monthStr, realtimeVersion]);

  // ---- day options ----------------------------------------------------------
  const dayOptions: DayOption[] = useMemo(() => {
    const opts: DayOption[] = [];
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    for (let d = daysInMonth; d >= 1; d--) {
      const dateObj = new Date(year, month, d);
      const value = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isUpcoming = `${year}-${String(month + 1).padStart(2, '0')}` > todayStr
        || (monthStr === todayStr && d > now.getDate());
      opts.push({
        value,
        label: `${dateObj.toLocaleDateString('en-US', { weekday: 'short' })}, ${MONTH_NAMES[month].slice(0, 3)} ${d}${isUpcoming ? ' (upcoming)' : ''}`,
        upcoming: isUpcoming,
        today: value === `${todayStr}-${String(now.getDate()).padStart(2, '0')}`,
      });
    }
    return opts;
     
  }, [year, month, daysInMonth]);

  const effectiveDay = Math.min(day, daysInMonth);
  const selectedDate = `${monthStr}-${String(effectiveDay).padStart(2, '0')}`;

  // ---- derived metrics --------------------------------------------------------
  const activeEmployees = employees ?? [];
  const dayRecords = (attendance ?? []).filter((a) => a.date === selectedDate);
  const countBy = (status: string) => dayRecords.filter((a) => a.status === status).length;

  const idleEmployees = activeEmployees.filter((e) => e.status === 'active' && !e.current_site_id);
  const workingEmployees = activeEmployees.filter((e) => e.status === 'active' && e.current_site_id);
  const pendingEmployees = activeEmployees.filter((e) => e.status === 'pending_deletion');

  // 6-month chart data
  const chartData = useMemo(() => {
    const byMonth = new Map<string, { month: string; present: number; absent: number }>();
    (summary ?? []).forEach((row) => {
      const entry = byMonth.get(row.month) ?? { month: row.month, present: 0, absent: 0 };
      if (row.status in entry) {
        (entry as unknown as Record<string, number>)[row.status] = row.count;
      }
      byMonth.set(row.month, entry);
    });
    return Array.from(byMonth.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({
        ...m,
        label: MONTH_NAMES[parseInt(m.month.slice(5), 10) - 1].slice(0, 3),
      }));
  }, [summary]);

  // donut data
  const donutData = [
    { name: 'Working', value: workingEmployees.length, color: '#22c55e' },
    { name: 'Idle / No Site', value: idleEmployees.length, color: '#f59e0b' },
    { name: 'Pending Deletion', value: pendingEmployees.length, color: '#71717a' },
  ].filter((d) => d.value > 0);

  // site breakdown (active sites with employees only)
  const siteBreakdown = useMemo(() => {
    if (!sites) return null;
    return sites
      .filter((s) => s.is_active)
      .map((s) => {
        const emps = activeEmployees.filter((e) => e.current_site_id === s.id);
        return {
          site: s,
          total: emps.length,
          active: emps.filter((e) => e.status === 'active').length,
          pending: emps.filter((e) => e.status === 'pending_deletion').length,
          leader: emps.find((e) => e.is_team_leader)?.full_name ?? null,
        };
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [sites, activeEmployees]);

  const yearOptions = [now.getFullYear() - 2, now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const loading = !employees || !attendance || !sites || !summary;
  const subtitle = dayRecords.length
    ? `${MONTH_NAMES[month]} ${effectiveDay}, ${year}`
    : `${MONTH_NAMES[month]} ${year}`;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Header + date pickers */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-emerald-500">
            {new Date(year, month, effectiveDay).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedDate} onValueChange={(v) => setDay(parseInt(v.slice(8), 10))}>
            <SelectTrigger className="h-10 w-40 bg-card"><CalendarDays className="mr-2 size-4 text-brand" /><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              {dayOptions.map((d) => (
                <SelectItem key={d.value} value={d.value} disabled={d.upcoming}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(month)} onValueChange={(v) => setMonth(parseInt(v, 10))}>
            <SelectTrigger className="h-10 w-28 bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((m, i) => (
                <SelectItem key={m} value={String(i)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={(v) => setYear(parseInt(v, 10))}>
            <SelectTrigger className="h-10 w-24 bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
        ) : (
          <>
            <StatCard label="Total Employees" value={activeEmployees.length} icon={<Users size={20} />} tone="brand" hint={subtitle} />
            <StatCard label="Present" value={countBy('present')} icon={<CheckCircle2 size={20} />} tone="emerald" hint={subtitle} />
            <StatCard label="Absent" value={countBy('absent')} icon={<XCircle size={20} />} tone="rose" hint={subtitle} />
          </>
        )}
      </div>

      {/* Idle employees card */}
      {!loading && (
        <motion.button
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.99 }}
          onClick={() => navigateToEmployees('idle')}
          className="card-glow flex w-full items-center justify-between rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4 text-left"
        >
          <div className="flex items-center gap-4">
            <div className="rounded-lg bg-amber-500/15 p-2.5 text-amber-500">
              <UserX size={20} />
            </div>
            <div>
              <p className="text-sm font-semibold">Unassigned / Idle Employees</p>
              <p className="text-xs text-muted-foreground">Click to view and assign them to a site</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold tabular-nums text-amber-500">{idleEmployees.length}</span>
            <Eye size={16} className="text-amber-500/70" />
          </div>
        </motion.button>
      )}

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-5">
        {/* Attendance bar chart */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
          className="card-glow rounded-xl border bg-card p-5 lg:col-span-3"
        >
          <SectionTitle icon={<Clock size={15} />} title="Monthly Attendance" sub="Last 6 months, per status" />
          <div className="mt-4 h-72">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgba(128,128,128,0.08)' }}
                    content={<ChartTooltip />}
                  />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="present" name="Present" stackId="a" fill={STATUS_COLORS.present} animationDuration={900} />
                  <Bar dataKey="absent" name="Absent" stackId="a" fill={STATUS_COLORS.absent} radius={[4, 4, 0, 0]} animationDuration={900} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </motion.div>

        {/* Donut */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="card-glow rounded-xl border bg-card p-5 lg:col-span-2"
        >
          <SectionTitle icon={<Users size={15} />} title="Employee Status" sub="Current distribution" />
          <div className="mt-4 h-72">
            {loading ? (
              <Skeleton className="h-full w-full" />
            ) : donutData.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No employees yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="45%"
                    innerRadius={58}
                    outerRadius={82}
                    paddingAngle={3}
                    animationDuration={900}
                    label={({ name, value }) => `${name}: ${value}`}
                    labelLine={false}
                  >
                    {donutData.map((d) => (
                      <Cell key={d.name} fill={d.color} stroke="var(--card)" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={<ChartTooltip />}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </motion.div>
      </div>

      {/* Site-wise breakdown */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="card-glow rounded-xl border bg-card p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle icon={<Building2 size={15} />} title="Site-wise Employee Breakdown" sub="Active sites only" />
          <Button variant="outline" size="sm" onClick={() => navigateTo('sites')}>
            View Sites <Eye size={14} className="ml-1.5" />
          </Button>
        </div>

        {!loading && siteBreakdown && siteBreakdown.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={<MapPin size={22} />}
              title="No active sites with employees"
              description="Create a site and assign employees to see the live breakdown here."
            />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Site Name</th>
                  <th className="pb-2 pr-4 font-medium">Team Leader</th>
                  <th className="pb-2 pr-4 font-medium">Employees</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {(siteBreakdown ?? []).map((row, i) => (
                  <motion.tr
                    key={row.site.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="border-b border-border/40 last:border-0"
                  >
                    <td className="py-3 pr-4">
                      <p className="font-medium">{row.site.name}</p>
                      {row.site.client_name && (
                        <p className="text-xs text-muted-foreground">Client: {row.site.client_name}</p>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {row.leader ? (
                        <span className="inline-flex items-center gap-1 text-xs">
                          <Crown size={12} className="fill-amber-400 text-amber-400" /> {row.leader}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="rounded-full bg-brand/10 px-2.5 py-0.5 text-sm font-semibold text-brand tabular-nums">
                        {row.total}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex flex-wrap gap-1.5">
                        {row.active > 0 && (
                          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-500">
                            {row.active} Active
                          </span>
                        )}
                        {row.pending > 0 && (
                          <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-500">
                            {row.pending} Pending
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 text-right">
                      <Button variant="ghost" size="sm" className={cn('text-brand')} onClick={() => navigateTo('sites')}>
                        <Eye size={14} />
                      </Button>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </div>
  );
}
