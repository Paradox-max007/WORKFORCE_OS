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
import { supabase } from '@/lib/supabase/client';
import type { RealtimeTable } from '@/lib/types';

export function useRealtimeVersion(tables: RealtimeTable[] | '*'): number {
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = dataApi.subscribe((changed) => {
      const hit =
        tables === '*' ||
        (changed as string[]).includes('*') ||
        (changed as string[]).some((t) => (tables as string[]).includes(t));
      if (hit) {
        // micro-debounce: many mutations emit bursts of events
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setVersion((v) => v + 1), 120);
      }
    });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      unsubscribe();
    };
     
  }, [Array.isArray(tables) ? tables.join(',') : tables]);

  return version;
}

// Realtime connection state for the "LIVE" indicator in the header.
// Supabase mode → real websocket channel status; demo mode → BroadcastChannel.
export function useRealtimeStatus(): 'connecting' | 'live' {
  const [status, setStatus] = useState<'connecting' | 'live'>('connecting');

  useEffect(() => {
    const client = supabase;
    if (client) {
      // Dedicated presence-free channel purely to track connection health
      const channel = client.channel('pulse-status');
      channel
        .on('broadcast', { event: 'ping' }, () => undefined)
        .subscribe((s) => {
          if (s === 'SUBSCRIBED') setStatus('live');
          else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') setStatus('connecting');
        });
      return () => {
        client.removeChannel(channel);
      };
    }
    // Demo mode: BroadcastChannel is instant — surface "live" after a short beat
    const t = setTimeout(() => setStatus('live'), 600);
    return () => clearTimeout(t);
  }, []);

  return status;
}
