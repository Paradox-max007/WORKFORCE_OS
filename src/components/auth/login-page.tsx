'use client';

// ============================================================================
// PULSE Workforce OS — Login page
// ============================================================================

import { motion } from 'framer-motion';
import { Eye, EyeOff, Loader2, LogIn, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isDemoMode } from '@/lib/data';
import { useAuthStore } from '@/store/auth-store';

export function LoginPage({ onInitialized }: { onInitialized?: () => void }) {
  const signIn = useAuthStore((s) => s.signIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      toast.success('Welcome back', { description: 'Signed in successfully.' });
      onInitialized?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      footer={
        isDemoMode ? (
          <div className="space-y-1">
            <p className="inline-flex items-center gap-1 text-amber-500">
              <Sparkles size={12} /> Demo mode — sample data is pre-loaded
            </p>
            <p className="text-muted-foreground">
              Super admin: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">super@pulse.app</code> ·{' '}
              Admin: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">admin@pulse.app</code> ·
              Password: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">demo1234</code>
            </p>
          </div>
        ) : undefined
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-500"
            role="alert"
          >
            {error}
          </motion.p>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            className="h-11"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="••••••••"
              className="h-11 pr-10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <Button type="submit" className="h-11 w-full brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Signing in…
            </>
          ) : (
            <>
              <LogIn className="mr-2 size-4" /> Sign In
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
