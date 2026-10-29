'use client';

// ============================================================================
// PULSE Workforce OS — Realtime hooks (Supabase Realtime / demo BroadcastChannel)
// ----------------------------------------------------------------------------
// useRealtimeVersion(tables) → increments a counter whenever any of the given
// tables change anywhere (your own writes included). Views depend on the
// version in their fetch effect → they automatically re-fetch & animate in.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { dataApi } from '@/lib/data';
import type { RealtimeTable } from '@/lib/types';

export function useRealtimeVersion(tables: RealtimeTable[] | '*'): number {
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = dataApi.subscribe((changed) => {
      if (tables === '*' || changed.includes('*') || changed.some((t) => (tables as string[]).includes(t))) {
        // micro-debounce: many mutations emit bursts of events
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setVersion((v) => v + 1), 120);
      }
    });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(tables) ? tables.join(',') : tables]);

  return version;
}

// Realtime connection state for the "LIVE" indicator in the header
export function useRealtimeStatus(): 'connecting' | 'live' {
  const [status, setStatus] = useState<'connecting' | 'live'>('connecting');
  useEffect(() => {
    const t = setTimeout(() => setStatus('live'), 900);
    return () => clearTimeout(t);
  }, []);
  return status;
}
