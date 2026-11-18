'use client';

// ============================================================================
// PULSE Workforce OS — My Settings (every admin's personal corner)
// ----------------------------------------------------------------------------
// What each signed-in admin can manage for THEMSELVES — no super-admin powers:
//
//   • Appearance — theme + accent are PER-USER now (stored on the profile,
//     applied instantly, following the admin across browsers). The org-wide
//     look in Site Settings only shapes the sign-in screen and new accounts.
//   • Account — read-only identity + self-service password change (the
//     current password is verified first; a super admin can still overwrite
//     any password from Admin Management).
// ============================================================================

import { useState } from 'react';
import {
  CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Moon, Palette, Save, ShieldCheck, Sun,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/shared/primitives';
import type { AccentColor, ThemeMode } from '@/lib/types';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';

const ACCENTS: { id: AccentColor; cls: string; label: string }[] = [
  { id: 'violet', cls: 'bg-violet-500', label: 'Violet' },
  { id: 'emerald', cls: 'bg-emerald-500', label: 'Emerald' },
  { id: 'amber', cls: 'bg-amber-500', label: 'Amber' },
  { id: 'rose', cls: 'bg-rose-500', label: 'Rose' },
];

export function MySettingsPage() {
  const user = useAuthStore((s) => s.user);
  const setTheme = useAuthStore((s) => s.setTheme);
  const setAccent = useAuthStore((s) => s.setAccent);
  const changeOwnPassword = useAuthStore((s) => s.changeOwnPassword);

  // ---- change password form ----
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  if (!user) return null;

  const submitPassword = async () => {
    setPwError(null);
    if (!currentPw) { setPwError('Enter your current password.'); return; }
    if (newPw.length < 6) { setPwError('The new password must be at least 6 characters.'); return; }
    if (newPw !== confirmPw) { setPwError('The new passwords do not match.'); return; }
    setSavingPw(true);
    try {
      await changeOwnPassword(currentPw, newPw);
      toast.success('Password updated', { description: 'Use the new password the next time you sign in.' });
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'The password change failed.');
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="My Settings"
        description="Your personal look for the app and your account password — these apply only to you."
      />

      {/* ---- Appearance (personal) ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette size={16} className="text-brand" /> Appearance
          </CardTitle>
          <CardDescription>
            Personalise PULSE for yourself — the theme and accent are saved to your account and follow
            you to every browser and device you sign in from.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>Theme</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                { id: 'dark' as ThemeMode, label: 'Dark', icon: Moon, preview: 'bg-zinc-950' },
                { id: 'light' as ThemeMode, label: 'Light', icon: Sun, preview: 'bg-zinc-100' },
              ]).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void setTheme(t.id)}
                  aria-pressed={user.theme === t.id}
                  className={cn(
                    'flex items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                    user.theme === t.id
                      ? 'border-brand/50 bg-brand/10'
                      : 'border-border/60 hover:border-brand/30 hover:bg-brand/5',
                  )}
                >
                  <span className={cn('flex size-9 items-center justify-center rounded-lg border', t.preview, 'border-border/60')}>
                    <t.icon size={16} className={t.id === 'dark' ? 'text-zinc-100' : 'text-zinc-800'} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{t.label} theme</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t.id === 'dark' ? 'Default PULSE look' : 'Bright, high-contrast'}
                    </span>
                  </span>
                  {user.theme === t.id && <CheckCircle2 size={16} className="ml-auto shrink-0 text-brand" />}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Accent color</Label>
            <div className="flex flex-wrap gap-2.5">
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => void setAccent(a.id)}
                  aria-pressed={user.accent === a.id}
                  className={cn(
                    'flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 text-sm font-medium transition-all',
                    user.accent === a.id
                      ? 'border-brand/50 bg-brand/10'
                      : 'border-border/60 hover:border-brand/30',
                  )}
                >
                  <span className={cn('size-5 rounded-full', a.cls)} />
                  {a.label}
                  {user.accent === a.id && <CheckCircle2 size={14} className="text-brand" />}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- Account & password ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck size={16} className="text-brand" /> Account &amp; Password
          </CardTitle>
          <CardDescription>
            Your sign-in identity. Change the password anytime — you only need your current one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={user.name} readOnly disabled />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={user.email} readOnly disabled />
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-brand/15 bg-brand/[0.03] p-4">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <KeyRound size={13} className="text-brand" /> Change password
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="cur-pw">Current password</Label>
                <div className="relative">
                  <Input
                    id="cur-pw"
                    type={showPw ? 'text' : 'password'}
                    value={currentPw}
                    onChange={(e) => { setCurrentPw(e.target.value); setPwError(null); }}
                    autoComplete="current-password"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide passwords' : 'Show passwords'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-pw">New password</Label>
                <Input
                  id="new-pw"
                  type={showPw ? 'text' : 'password'}
                  value={newPw}
                  onChange={(e) => { setNewPw(e.target.value); setPwError(null); }}
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-pw">Confirm new password</Label>
                <Input
                  id="confirm-pw"
                  type={showPw ? 'text' : 'password'}
                  value={confirmPw}
                  onChange={(e) => { setConfirmPw(e.target.value); setPwError(null); }}
                  autoComplete="new-password"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitPassword(); } }}
                />
              </div>
            </div>
            {pwError && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {pwError}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">
                Forgot it? A super admin can reset your password from Admin Management anytime.
              </p>
              <Button
                onClick={() => void submitPassword()}
                disabled={savingPw || !currentPw || !newPw || !confirmPw}
                className="gap-1.5 font-semibold"
              >
                {savingPw ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Update password
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
