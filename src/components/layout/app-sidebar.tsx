'use client';

// ============================================================================
// PULSE Workforce OS — Animated sidebar (desktop collapsible + mobile drawer)
// ============================================================================

import { motion } from 'framer-motion';
import {
  Bell, ChevronDown, ChevronLeft, ChevronRight, LogOut, Moon, Sun,
} from 'lucide-react';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { dataApi } from '@/lib/data';
import { initials, fmtTimeAgo } from '@/lib/format';
import { MENUS, MENU_GROUPS, menuAllows, menuRenderList, type MenuDef } from '@/lib/menus';
import type { AccentColor, Profile } from '@/lib/types';
import { useAppStore, type AppView } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useRealtimeVersion } from '@/store/realtime';
import { toast } from 'sonner';

// Sidebar menus come from lib/menus.ts — the single source of truth shared
// with Admin Management permissions. Adding a menu there is all it takes.

// (NAV_ITEMS removed — see lib/menus.ts MENUS)

const ACCENTS: { id: AccentColor; cls: string }[] = [
  { id: 'violet', cls: 'bg-violet-500' },
  { id: 'emerald', cls: 'bg-emerald-500' },
  { id: 'amber', cls: 'bg-amber-500' },
  { id: 'rose', cls: 'bg-rose-500' },
];

function useUnreadCount(user: Profile | null): number {
  const [count, setCount] = useState(0);
  const version = useRealtimeVersion(['notification']);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await dataApi.getUnreadNotificationCount();
        if (!cancelled) setCount(c);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
     
  }, [user?.id, version]);
  return count;
}

// ---------------------------------------------------------------------------
// Nav button (single menu entry — top level or inside a group)
// ---------------------------------------------------------------------------
function NavButton({ item, active, collapsed, onNav, unread }: {
  item: MenuDef;
  active: boolean;
  collapsed: boolean;
  onNav: (id: AppView) => void;
  unread: number;
}) {
  const showBadge = item.id === 'notifications' && unread > 0;
  return (
    <button
      onClick={() => onNav(item.id)}
      title={collapsed ? item.label : undefined}
      className={cn(
        'group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        collapsed && 'justify-center px-0 py-3',
      )}
    >
      {active && (
        <motion.span
          layoutId="sidebar-active"
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="absolute inset-0 rounded-xl border border-brand/25 bg-brand/10"
        />
      )}
      <span className="relative z-10 flex items-center">
        <item.icon className={cn('size-[18px] transition-colors', active ? 'text-brand' : 'group-hover:text-brand')} />
        {showBadge && (
          <span
            className={cn(
              'absolute -right-2.5 -top-2 rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white shadow',
              collapsed && 'right-[-10px]',
            )}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </span>
      {!collapsed && <span className="relative z-10 truncate">{item.label}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Collapsible menu group (e.g. "Salary Details")
// ---------------------------------------------------------------------------
function NavGroup({ group, items, collapsed, onNav, currentView, unread }: {
  group: (typeof MENU_GROUPS)[string];
  items: MenuDef[];
  collapsed: boolean;
  onNav: (id: AppView) => void;
  currentView: AppView;
  unread: number;
}) {
  const containsActive = items.some((x) => x.id === currentView);
  const [open, setOpen] = useState(containsActive);

  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);

  // rail (collapsed) mode: no room for a dropdown — children stay reachable
  if (collapsed) {
    return (
      <>
        {items.map((item) => (
          <NavButton key={item.id} item={item} active={currentView === item.id}
            collapsed onNav={onNav} unread={unread} />
        ))}
      </>
    );
  }

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
          containsActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <group.icon className={cn('size-[18px] transition-colors', containsActive ? 'text-brand' : 'group-hover:text-brand')} />
        <span className="flex-1 truncate text-left">{group.label}</span>
        {open
          ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div className="ml-4 space-y-0.5 border-l border-border/60 pl-2">
          {items.map((item) => (
            <NavButton key={item.id} item={item} active={currentView === item.id}
              collapsed={false} onNav={onNav} unread={unread} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar content (shared between desktop rail and mobile sheet)
// ---------------------------------------------------------------------------
function SidebarContent({
  user,
  collapsed,
  onNavigate,
}: {
  user: Profile;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { currentView, navigateTo, navigateToEmployees } = useAppStore();
  const signOut = useAuthStore((s) => s.signOut);
  const setTheme = useAuthStore((s) => s.setTheme);
  const setAccent = useAuthStore((s) => s.setAccent);
  const perms = useAuthStore((s) => s.menuPermissions);
  const unread = useUnreadCount(user);
  const [latestNotification, setLatestNotification] = useState<string | null>(null);
  const version = useRealtimeVersion(['notification']);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await dataApi.listNotifications();
        const first = list.filter((n) => !n.read)[0] ?? list[0];
        if (!cancelled && first) {
          setLatestNotification(`${first.title} · ${fmtTimeAgo(first.created_at)}`);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
     
  }, [user?.id, version]);

  const allowed = (id: AppView): boolean => {
    if (user.role === 'super_admin') return true;
    // config-driven: unmanaged menus follow their defaultOn flag, managed
    // menus follow the permission row (falling back to defaultOn)
    return menuAllows(perms, id);
  };

  const visibleItems = MENUS.filter((item) => allowed(item.id));

  const handleNav = (id: AppView) => {
    if (id === 'employees') navigateToEmployees();
    else navigateTo(id);
    onNavigate?.();
  };

  const handleSignOut = async () => {
    await signOut();
    toast.success('Signed out');
  };

  return (
    <div className="flex h-full flex-col">
      {/* Logo */}
      <div className={cn('flex items-center gap-3 px-4 py-5', collapsed && 'justify-center px-2')}>
        <div className="relative shrink-0">
          <div className="absolute inset-0 rounded-xl brand-gradient opacity-40 blur-md" />
          <Image src="/logo.svg" alt="PULSE logo" width={36} height={36} className="relative rounded-xl" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-sm font-bold leading-tight">
              PULSE <span className="gradient-text">Workforce</span>
            </p>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Operations OS</p>
          </div>
        )}
      </div>

      {/* Nav — scrolls independently ONLY when the menu list outgrows the viewport */}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {menuRenderList(visibleItems).map((entry) =>
          entry.group ? (
            <NavGroup
              key={entry.group.id}
              group={entry.group}
              items={entry.items as MenuDef[]}
              collapsed={collapsed}
              onNav={handleNav}
              currentView={currentView}
              unread={unread}
            />
          ) : (
            entry.menu && (
              <NavButton
                key={entry.menu.id}
                item={entry.menu as MenuDef}
                active={currentView === entry.menu.id}
                collapsed={collapsed}
                onNav={handleNav}
                unread={unread}
              />
            )
          ))}
      </nav>

      {/* Latest notification hint */}
      {!collapsed && latestNotification && (
        <button
          onClick={() => handleNav('notifications')}
          className="mx-2 mb-2 truncate rounded-lg border border-brand/15 bg-brand/5 px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-brand/10"
        >
          <span className="mr-1 inline-block size-1.5 rounded-full bg-brand align-middle" />
          {latestNotification}
        </button>
      )}

      {/* User footer */}
      <div className={cn('border-t border-border/60 p-3', collapsed && 'px-2')}>
        <div className={cn('flex items-center gap-3', collapsed && 'flex-col')}>
          <div className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-xs font-bold text-brand">
            {initials(user.name)}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                {user.role === 'super_admin' ? '👑 Super Admin' : 'Admin'}
              </p>
            </div>
          )}
          {!collapsed && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                title={user.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                onClick={() => setTheme(user.theme === 'dark' ? 'light' : 'dark')}
              >
                {user.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10"
                title="Sign out"
                onClick={handleSignOut}
              >
                <LogOut size={15} />
              </Button>
            </div>
          )}
        </div>

        {/* Accent picker */}
        <div className={cn('mt-3 flex items-center gap-1.5', collapsed ? 'flex-col' : 'justify-center')}>
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              onClick={() => setAccent(a.id)}
              title={`${a.id} accent`}
              className={cn(
                'size-3.5 rounded-full border-2 transition-all hover:scale-125',
                a.cls,
                user.accent === a.id ? 'border-foreground/80 scale-110' : 'border-transparent opacity-60',
              )}
            />
          ))}
        </div>

        {collapsed && (
          <div className="mt-3 flex flex-col items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-foreground"
              title={user.theme === 'dark' ? 'Light theme' : 'Dark theme'}
              onClick={() => setTheme(user.theme === 'dark' ? 'light' : 'dark')}
            >
              {user.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-500"
              title="Sign out"
              onClick={handleSignOut}
            >
              <LogOut size={15} />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop sidebar with collapse toggle
// ---------------------------------------------------------------------------
export function AppSidebar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const user = useAuthStore((s) => s.user);

  if (!user) return null;

  return (
    <motion.aside
      initial={false}
      animate={{ width: sidebarOpen ? 264 : 76 }}
      transition={{ type: 'spring', stiffness: 300, damping: 32 }}
      className="sticky top-0 z-30 hidden h-screen shrink-0 border-r border-border/60 bg-sidebar md:block"
    >
      <SidebarContent user={user} collapsed={!sidebarOpen} />
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="absolute -right-3 top-20 flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm transition-all hover:text-brand hover:border-brand/40 hover:shadow-md"
        aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
      >
        <motion.span animate={{ rotate: sidebarOpen ? 0 : 180 }} transition={{ duration: 0.3 }}>
          <ChevronLeft size={13} />
        </motion.span>
      </button>
    </motion.aside>
  );
}

// ---------------------------------------------------------------------------
// Mobile sidebar (Sheet drawer) — trigger lives in the header
// ---------------------------------------------------------------------------
export function MobileSidebarTrigger() {
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  if (!user) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" className="md:hidden" aria-label="Open menu">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 border-border/60 bg-sidebar p-0">
        {/* accessible labels for screen readers (Radix Dialog/Sheet requires a
            Title — hidden visually, the drawer itself shows the app logo) */}
        <SheetHeader className="sr-only">
          <SheetTitle>Navigation menu</SheetTitle>
          <SheetDescription>PULSE Workforce OS app navigation</SheetDescription>
        </SheetHeader>
        <SidebarContent user={user} collapsed={false} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
