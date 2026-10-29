'use client';

// ============================================================================
// PULSE Workforce OS — First-run signup page ("Initialize System")
// ============================================================================

import { motion } from 'framer-motion';
import { Crown, Eye, EyeOff, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/store/auth-store';

export function SignupPage() {
  const signUpInitial = useAuthStore((s) => s.signUpInitial);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Please enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Please enter a valid email address.');
    if (password.length < 6) return setError('Password must be at least 6 characters.');
    if (password !== confirm) return setError('Passwords do not match.');

    setLoading(true);
    try {
      await signUpInitial(name.trim(), email.trim(), password);
      toast.success('System initialized', { description: 'Your super admin account is ready.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      footer={
        <p className="inline-flex items-center gap-1">
          <ShieldCheck size={12} className="text-emerald-500" />
          This account will have full system access.
        </p>
      }
    >
      <div className="mb-5 flex items-center gap-2 rounded-xl border border-brand/25 bg-brand/5 p-3 text-xs text-muted-foreground">
        <Sparkles size={14} className="shrink-0 text-brand" />
        No accounts exist yet — the first account you create becomes the <strong className="text-foreground">Super Admin</strong> with full access.
      </div>

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
          <Label htmlFor="name">Full Name</Label>
          <Input id="name" placeholder="e.g. Amira Sultan" className="h-11" value={name} onChange={(e) => setName(e.target.value)} disabled={loading} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" placeholder="you@company.com" className="h-11" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Min 6 characters"
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
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm</Label>
            <Input
              id="confirm"
              type={showPassword ? 'text' : 'password'}
              placeholder="Repeat password"
              className="h-11"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={loading}
            />
          </div>
        </div>

        <Button type="submit" className="h-11 w-full brand-gradient font-semibold text-white shadow-lg shadow-[var(--glow)] transition-transform active:scale-[0.98]" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Creating account…
            </>
          ) : (
            <>
              <Crown className="mr-2 size-4" /> Create Super Admin Account
            </>
          )}
        </Button>
      </form>
    </AuthShell>
  );
}
