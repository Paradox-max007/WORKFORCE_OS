'use client';

// ============================================================================
// PULSE Workforce OS — Application shell (SPA)
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { LoginPage } from '@/components/auth/login-page';
import { SignupPage } from '@/components/auth/signup-page';
import { AdminPage } from '@/components/admins/admin-page';
import { AttendancePage } from '@/components/attendance/attendance-page';
import { CampsPage } from '@/components/camps/camps-page';
import { CancellationRequestPage } from '@/components/cancellation-requests/cancellation-request-page';
import { DashboardPage } from '@/components/dashboard/dashboard-page';
import { EmployeeDetailsPage } from '@/components/employees/employee-details-page';
import { EmployeeFormPage } from '@/components/employees/employee-form-page';
import { EmployeePage } from '@/components/employees/employee-page';
import { AppHeader } from '@/components/layout/app-header';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { LeaveRequestPage } from '@/components/leave-requests/leave-request-page';
import { NotificationPage } from '@/components/notifications/notification-page';
import { SitesPage } from '@/components/sites/sites-page';
import { UniformRegistryPage } from '@/components/uniform-registry/uniform-registry-page';
import { dataApi, isDemoMode } from '@/lib/data';
import { useAppStore, type AppView } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';

// ---------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------
function LoadingScreen() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="aurora-blob left-[10%] top-[-20%] size-[30rem] brand-gradient opacity-20" />
        <div className="aurora-blob bottom-[-30%] right-[-5%] size-[26rem] bg-emerald-500 opacity-10 [animation-delay:-7s]" />
      </div>
      <div className="relative z-10 flex flex-col items-center gap-4">
        <motion.div
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          className="relative"
        >
          <div className="absolute inset-0 rounded-3xl brand-gradient opacity-50 blur-xl" />
          <Image src="/logo.svg" alt="PULSE" width={64} height={64} className="relative rounded-3xl" priority />
        </motion.div>
        <p className="text-sm font-medium text-muted-foreground">
          Waking the <span className="gradient-text font-semibold">pulse</span>…
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main layout with animated view switching
// ---------------------------------------------------------------------------
function MainLayout() {
  const currentView = useAppStore((s) => s.currentView);

  const views: Record<AppView, React.ReactNode> = {
    dashboard: <DashboardPage />,
    employees: <EmployeePage />,
    employee_details: <EmployeeDetailsPage />,
    employee_form: <EmployeeFormPage />,
    sites: <SitesPage />,
    camps: <CampsPage />,
    attendance: <AttendancePage />,
    uniform_registry: <UniformRegistryPage />,
    leave_requests: <LeaveRequestPage />,
    cancellation_requests: <CancellationRequestPage />,
    notifications: <NotificationPage />,
    admins: <AdminPage />,
  };

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <main className="flex-1 p-4 md:p-6 lg:p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentView}
              initial={{ opacity: 0, y: 14, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {views[currentView]}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo banner
// ---------------------------------------------------------------------------
function DemoBanner() {
  const [dismissed, setDismissed] = useState(false);
  if (!isDemoMode || dismissed) return null;
  return (
    <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-center text-[11px] text-amber-600 dark:text-amber-400">
      Demo mode — sample data, sign-ins persist locally. Connect Supabase env vars to go live.
      <button className="ml-3 font-semibold underline underline-offset-2" onClick={() => setDismissed(true)}>dismiss</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function Home() {
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const [hasProfiles, setHasProfiles] = useState<boolean | null>(null);

  useEffect(() => {
    bootstrap();
    dataApi.hasProfiles().then(setHasProfiles).catch(() => setHasProfiles(true));
  }, [bootstrap]);

  // Sync theme + accent to <html>
  useEffect(() => {
    const root = document.documentElement;
    const theme = user?.theme ?? 'dark';
    const accent = user?.accent ?? 'violet';
    root.classList.toggle('dark', theme === 'dark');
    root.dataset.accent = accent;
  }, [user?.theme, user?.accent]);

  if (isLoading) return <LoadingScreen />;

  if (!user) {
    if (hasProfiles === false) return <SignupPage />;
    return <LoginPage />;
  }

  return (
    <>
      <DemoBanner />
      <MainLayout />
    </>
  );
}
