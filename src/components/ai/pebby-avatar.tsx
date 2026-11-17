// ============================================================================
// PULSE Workforce OS — Pebby's face: a cute little pebble
// ----------------------------------------------------------------------------
// A soft stone with glossy eyes, a tiny smile, blush marks and a shine streak.
// The stone's palette is theme-independent, so the same face reads well on the
// brand-gradient chip (launcher + chat header), on cards and in dark mode.
// Pure SVG — no image assets, scales to any size via className.
// ============================================================================

import { useId } from 'react';
import { cn } from '@/lib/utils';

export function PebbleAvatar({ className }: { className?: string }) {
  const gid = useId();
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('block select-none', className)}
      role="img"
      aria-label="Pebby — a cute pebble"
      focusable="false"
    >
      <defs>
        <radialGradient id={gid} cx="38%" cy="28%" r="85%">
          <stop offset="0%" stopColor="#fbfbfe" />
          <stop offset="55%" stopColor="#dcdfe9" />
          <stop offset="100%" stopColor="#b4bacb" />
        </radialGradient>
      </defs>

      {/* stone body — a smooth, slightly lopsided pebble */}
      <path
        d="M33 8C46 8 56 19.5 55 33.5 54 47.5 45 56.5 31 56.5 17 56.5 8 47 8 32.5 8 17.5 20 8 33 8Z"
        fill={`url(#${gid})`}
        stroke="#8b90a8"
        strokeWidth="2"
      />

      {/* glossy shine streak */}
      <path
        d="M15 23.5C16.8 16.6 22.5 12.4 28.6 11.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.8"
      />

      {/* pebble speckles */}
      <circle cx="20.5" cy="18.5" r="1.3" fill="#a2a8bf" opacity="0.85" />
      <circle cx="44" cy="20" r="1.1" fill="#a2a8bf" opacity="0.8" />
      <circle cx="38.5" cy="14.8" r="0.9" fill="#a2a8bf" opacity="0.8" />
      <circle cx="47.5" cy="44" r="1" fill="#a2a8bf" opacity="0.7" />

      {/* blush */}
      <ellipse cx="17" cy="37" rx="4" ry="2.6" fill="#f5a8bf" opacity="0.65" />
      <ellipse cx="47" cy="37" rx="4" ry="2.6" fill="#f5a8bf" opacity="0.65" />

      {/* eyes */}
      <ellipse cx="24.5" cy="30.5" rx="3.1" ry="4.5" fill="#3a3d4c" />
      <ellipse cx="39.5" cy="30.5" rx="3.1" ry="4.5" fill="#3a3d4c" />
      <circle cx="23.4" cy="28.6" r="1.25" fill="#ffffff" />
      <circle cx="38.4" cy="28.6" r="1.25" fill="#ffffff" />

      {/* smile */}
      <path
        d="M26.5 39.5Q32 44.8 37.5 39.5"
        fill="none"
        stroke="#3a3d4c"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
