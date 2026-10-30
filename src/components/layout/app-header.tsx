'use client';

// ============================================================================
// PULSE Workforce OS — App header (title, LIVE indicator, bell, user menu)
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import { Bell, LogOut, Menu, Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MobileSidebarTrigger } from '@/components/layout/app-sidebar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isDemoMode } from '@/lib/data';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Profile } from '@/lib/types';
import { useAppStore, VIEW_TITLES } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeStatus, useRealtimeVersion } from '@/store/realtime';

export function AppHeader() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const currentView = useAppStore((s) => s.currentView);
  const navigateTo = useAppStore((s) => s.navigateTo);
  const status = useRealtimeStatus();
  const [unread, setUnread] = useState(0);
  const version = useRealtimeVersion(['notification']);
  const prevUnread = useRef(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await (await import('@/lib/data')).dataApi.getUnreadNotificationCount();
        if (!cancelled) setUnread(c);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [user, version]);

  // toast when new notifications arrive in realtime
  useEffect(() => {
    if (unread > prevUnread.current && prevUnread.current !== 0) {
      toast.info('New notification', { description: `You have ${unread} unread notification${unread > 1 ? 's' : ''}.` });
    }
    prevUnread.current = unread;
  }, [unread]);

  if (!user) return null;

  const title = VIEW_TITLES[currentView];

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur-xl md:px-6">
      <MobileSidebarTrigger />
      <Menu className="hidden size-4 text-muted-foreground" />

      <div className="flex min-w-0 items-center gap-3">
        <AnimatePresence mode="wait">
          <motion.h2
            key={title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
            className="truncate text-base font-semibold tracking-tight md:text-lg"
          >
            {title}
          </motion.h2>
        </AnimatePresence>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* LIVE indicator */}
        <div
          className={cn(
            'hidden items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold sm:flex',
            status === 'live'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-500',
          )}
          title={isDemoMode ? 'Realtime via BroadcastChannel (demo mode)' : 'Supabase Realtime connected'}
        >
          <span className="relative flex size-2">
            {status === 'live' && <span className="pulse-dot absolute inset-0 rounded-full" />}
            <span className="relative size-2 rounded-full bg-current" />
          </span>
          {status === 'live' ? 'LIVE' : 'CONNECTING'}
          <Radio size={11} className="opacity-70" />
        </div>

        {/* Notification bell */}
        <Button
          variant="outline"
          size="icon"
          className="relative shrink-0"
          aria-label={`Notifications (${unread} unread)`}
          onClick={() => navigateTo('notifications')}
        >
          <Bell size={16} />
          {unread > 0 && (
            <motion.span
              key={unread}
              initial={{ scale: 0.4 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              className="absolute -right-1.5 -top-1.5 flex min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 py-px text-[10px] font-bold text-white shadow"
            >
              {unread > 9 ? '9+' : unread}
            </motion.span>
          )}
        </Button>

        {/* User menu */}
        <UserMenu user={user} onSignOut={async () => { await signOut(); toast.success('Signed out'); }} />
      </div>
    </header>
  );
}

function UserMenu({ user, onSignOut }: { user: Profile; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-full border border-border/60 bg-card py-1 pl-1 pr-3 transition-colors hover:border-brand/40"
          aria-label="Account menu"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-brand/15 text-[11px] font-bold text-brand">
            {initials(user.name)}
          </span>
          <span className="hidden max-w-28 truncate text-sm font-medium sm:block">{user.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <p className="truncate text-sm font-semibold">{user.name}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
              user.role === 'super_admin'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-500'
                : 'border-brand/30 bg-brand/10 text-brand',
            )}
          >
            {user.role === 'super_admin' ? '👑 Super Admin' : 'Admin'}
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut} className="text-rose-500 focus:text-rose-500">
          <LogOut size={15} className="mr-2" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
