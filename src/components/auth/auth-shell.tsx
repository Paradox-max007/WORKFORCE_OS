'use client';

// ============================================================================
// PULSE Workforce OS — Shared animated auth shell (aurora + glass card)
// ============================================================================

import { motion } from 'framer-motion';
import Image from 'next/image';
import type { ReactNode } from 'react';

export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* aurora background */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="aurora-blob left-[-10%] top-[-15%] size-[34rem] brand-gradient opacity-25" />
        <div className="aurora-blob right-[-8%] top-[10%] size-[26rem] bg-emerald-500 opacity-15 [animation-delay:-6s]" />
        <div className="aurora-blob bottom-[-20%] left-[30%] size-[30rem] bg-fuchsia-500 opacity-15 [animation-delay:-10s]" />
        <div className="absolute inset-0 grid-texture" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="glass-card rounded-2xl border p-8 shadow-2xl"
        >
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <motion.div
              initial={{ scale: 0, rotate: -12 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.15 }}
              className="relative"
            >
              <div className="absolute inset-0 rounded-2xl brand-gradient opacity-40 blur-xl" />
              <Image src="/logo.svg" alt="PULSE logo" width={56} height={56} className="relative rounded-2xl" priority />
            </motion.div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                PULSE <span className="gradient-text font-bold">Workforce OS</span>
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">The live pulse of your workforce operations.</p>
            </div>
          </div>
          {children}
        </motion.div>
        {footer && <div className="mt-5 text-center text-xs text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}
