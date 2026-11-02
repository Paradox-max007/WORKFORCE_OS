'use client';

// ============================================================================
// PULSE Workforce OS — Working Hours loading skeleton
// ----------------------------------------------------------------------------

export function WorkingHoursSkeleton() {
  return (
    <div className="space-y-5">
      <div className="shimmer h-44 rounded-2xl border" />
      <div className="shimmer h-12 rounded-xl border" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="shimmer h-16 rounded-xl border" />
        ))}
      </div>
    </div>
  );
}
