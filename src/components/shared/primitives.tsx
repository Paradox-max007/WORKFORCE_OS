'use client';

// ============================================================================
// PULSE Workforce OS — Shared UI primitives (badges, stars, cards, counters)
// ============================================================================

import { motion, useInView, useMotionValue, useSpring } from 'framer-motion';
import { Star, StarHalf } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Animated counter (used on stat cards)
// ---------------------------------------------------------------------------
export function AnimatedCounter({
  value,
  decimals = 0,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, { duration: 1200, bounce: 0 });

  useEffect(() => {
    if (inView) motionValue.set(value);
  }, [inView, value, motionValue]);

  useEffect(() => {
    const unsub = spring.on('change', (v) => {
      if (ref.current) ref.current.textContent = v.toFixed(decimals);
    });
    return unsub;
  }, [spring, decimals]);

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      0
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------
export function EmployeeStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: 'Active', cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/25' },
    pending_deletion: { label: 'Pending Deletion', cls: 'bg-amber-500/10 text-amber-500 border-amber-500/25' },
    deleted: { label: 'Deleted', cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/25' },
  };
  const cfg = map[status] ?? { label: status, cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/25' };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', cfg.cls)}>
      <span className="size-1.5 rounded-full bg-current" />
      {cfg.label}
    </span>
  );
}

export function RequestStatusBadge({ status }: { status: 'pending' | 'approved' | 'rejected' }) {
  const map = {
    pending: { label: 'Pending', cls: 'bg-amber-500/10 text-amber-500 border-amber-500/25' },
    approved: { label: 'Approved', cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/25' },
    rejected: { label: 'Rejected', cls: 'bg-rose-500/10 text-rose-500 border-rose-500/25' },
  };
  const cfg = map[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', cfg.cls)}>
      <span className="size-1.5 rounded-full bg-current" />
      {cfg.label}
    </span>
  );
}

export function SiteBadge({ name }: { name: string | null }) {
  if (!name) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
        Idle · No Site
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rating stars
// ---------------------------------------------------------------------------
export function RatingStars({ rating, size = 14 }: { rating: number; size?: number }) {
  const stars: ReactNode[] = [];
  for (let i = 1; i <= 5; i++) {
    if (rating >= i - 0.25) {
      stars.push(<Star key={i} size={size} className="fill-amber-400 text-amber-400" />);
    } else if (rating >= i - 0.75) {
      stars.push(
        <span key={i} className="relative inline-flex">
          <Star size={size} className="text-muted-foreground/40" />
          <StarHalf size={size} className="absolute left-0 top-0 fill-amber-400 text-amber-400" />
        </span>,
      );
    } else {
      stars.push(<Star key={i} size={size} className="text-muted-foreground/40" />);
    }
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      {stars}
      <span className="ml-1 text-xs font-medium tabular-nums text-muted-foreground">{rating.toFixed(1)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page section header
// ---------------------------------------------------------------------------
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </motion.div>
      {actions && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-wrap items-center gap-2"
        >
          {actions}
        </motion.div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card (dashboard + request pages)
// ---------------------------------------------------------------------------
export function StatCard({
  label,
  value,
  icon,
  tone = 'brand',
  decimals = 0,
  onClick,
  hint,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone?: 'brand' | 'emerald' | 'rose' | 'amber' | 'purple' | 'cyan';
  decimals?: number;
  onClick?: () => void;
  hint?: string;
}) {
  const tones: Record<string, string> = {
    brand: 'text-brand bg-brand/10',
    emerald: 'text-emerald-500 bg-emerald-500/10',
    rose: 'text-rose-500 bg-rose-500/10',
    amber: 'text-amber-500 bg-amber-500/10',
    purple: 'text-purple-500 bg-purple-500/10',
    cyan: 'text-cyan-500 bg-cyan-500/10',
  };
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      whileHover={onClick ? { y: -3 } : undefined}
      whileTap={onClick ? { scale: 0.98 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      className={cn(
        'card-glow group relative flex items-center justify-between overflow-hidden rounded-xl border bg-card p-4 text-left',
        onClick && 'cursor-pointer',
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">
          <AnimatedCounter value={value} decimals={decimals} />
        </p>
        {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{hint}</p>}
      </div>
      <div className={cn('rounded-lg p-2.5 transition-transform duration-300 group-hover:scale-110', tones[tone])}>
        {icon}
      </div>
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center"
    >
      <motion.div
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        className="rounded-2xl bg-brand/10 p-4 text-brand"
      >
        {icon}
      </motion.div>
      <div>
        <p className="font-medium">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton with shimmer
// ---------------------------------------------------------------------------
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="shimmer h-14 rounded-xl border" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section title within a page
// ---------------------------------------------------------------------------
export function SectionTitle({ icon, title, sub }: { icon?: ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {icon && <div className="rounded-lg bg-brand/10 p-1.5 text-brand">{icon}</div>}
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}
