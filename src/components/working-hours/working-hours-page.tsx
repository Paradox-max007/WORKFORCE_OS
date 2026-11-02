'use client';

// ============================================================================
// PULSE Workforce OS — Employee Working Hours page
// ----------------------------------------------------------------------------
// Management drill-down: pick any employee (search by name / ID / trade /
// site) and immediately see their LIFETIME working hours = historical opening
// balance + every attendance-recorded hour, split by month and site.
//
// • the report is aggregated DATABASE-SIDE (get_employee_working_hours RPC in
//   production; the mirrored demo calculation in demo mode) — never by
//   downloading the whole attendance history
// • each attendance day's site is resolved with the shared date-effective
//   transfer engine, so mid-month moves split the month correctly and days
//   already marked at the old site stay with the old site
// • the opening balance is NEVER spread over months/sites — it is reported as
//   one number (historical breakdown unavailable by design)
// • realtime: marking attendance, editing hours, transferring sites or
//   touching employees refreshes the open report automatically
// ============================================================================

import { Clock, SearchX, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, PageHeader } from '@/components/shared/primitives';
import { dataApi } from '@/lib/data';
import type { EmployeeVM, EmployeeWorkingHoursReport } from '@/lib/types';
import { useRealtimeVersion } from '@/store/realtime';
import { EmployeeHoursSummary } from './employee-hours-summary';
import { EmployeeSearch } from './employee-search';
import { MonthlyHoursList } from './monthly-hours-list';
import { WorkingHoursSkeleton } from './working-hours-skeleton';

// Report fetch state — 'idle' until an employee is picked. The employee id is
// carried inside ready/error so the view can derive "still loading the
// currently selected employee" without touching state inside effects.
type ReportState =
  | { phase: 'idle' }
  | { phase: 'ready'; id: string; report: EmployeeWorkingHoursReport }
  | { phase: 'error'; id: string; message: string };

export function WorkingHoursPage() {
  // any attendance mark / correction, site transfer, employee edit or site
  // rename refreshes both the picker and the open report
  const realtimeVersion = useRealtimeVersion(['attendance', 'employee', 'site', 'site_transfer']);

  const [employees, setEmployees] = useState<EmployeeVM[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reportState, setReportState] = useState<ReportState>({ phase: 'idle' });

  // employee picker list (fresh on every relevant change)
  useEffect(() => {
    let cancelled = false;
    dataApi.listEmployees()
      .then((emps) => { if (!cancelled) setEmployees(emps); })
      .catch(() => {
        if (!cancelled) {
          setEmployees([]);
          toast.error('Failed to load employees');
        }
      });
    return () => { cancelled = true; };
  }, [realtimeVersion]);

  // the selection is derived through the fresh employee list — a deleted
  // employee quietly falls back to the search prompt, no state juggling
  const effectiveSelectedId =
    selectedId !== null && employees !== null && !employees.some((e) => e.id === selectedId)
      ? null
      : selectedId;

  // the report itself — fetched only after an employee is selected
  useEffect(() => {
    const id = effectiveSelectedId;
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const report = await dataApi.getEmployeeWorkingHours(id);
        if (!cancelled) setReportState({ phase: 'ready', id, report });
      } catch (err) {
        if (!cancelled) {
          setReportState({
            phase: 'error', id,
            message: err instanceof Error ? err.message : 'Failed to load the report',
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveSelectedId, realtimeVersion]);

  // derived view state (a fetch for another employee is in flight → skeleton)
  const reportLoading =
    effectiveSelectedId !== null &&
    (reportState.phase === 'idle' || reportState.id !== effectiveSelectedId);
  const report =
    reportState.phase === 'ready' && reportState.id === effectiveSelectedId ? reportState.report : null;
  const reportError =
    reportState.phase === 'error' && reportState.id === effectiveSelectedId ? reportState.message : null;

  const pickerLoading = employees === null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Working Hours"
        description="Employee lifetime working hours and monthly history — opening balance plus every attendance-recorded hour, split by month and site."
      />

      {/* employee search */}
      <div className="card-glow rounded-2xl border bg-card p-4 md:p-5">
        <p className="mb-3 text-sm font-semibold">Search &amp; view employee working-hour records</p>
        <EmployeeSearch
          employees={employees ?? []}
          value={effectiveSelectedId}
          onChange={(id) => setSelectedId(id)}
          loading={pickerLoading}
        />
        <p className="mt-2.5 text-[11px] text-muted-foreground">
          Search by name, employee ID, trade or current site. The report loads only after you pick
          someone — nothing is fetched up front.
        </p>
      </div>

      <div className="mt-5">
        {!effectiveSelectedId ? (
          <EmptyState
            icon={<SearchX size={26} />}
            title="Pick an employee to see their working hours"
            description="Lifetime hours = the employee's opening balance + every hour PULSE has recorded through attendance. Existing employees can start with their accumulated hours; new employees start at zero."
          />
        ) : reportLoading ? (
          <WorkingHoursSkeleton />
        ) : reportError ? (
          <EmptyState
            icon={<TriangleAlert size={26} />}
            title="Couldn't load the working-hours report"
            description={reportError}
          />
        ) : report ? (
          <div className="space-y-5">
            <EmployeeHoursSummary report={report} />
            {/* remounts per employee → the latest month starts expanded */}
            <MonthlyHoursList key={report.employeeId} months={report.monthlyBreakdown} />
          </div>
        ) : (
          <EmptyState
            icon={<Clock size={26} />}
            title="No report"
            description="Select an employee above to load their working hours."
          />
        )}
      </div>
    </div>
  );
}
