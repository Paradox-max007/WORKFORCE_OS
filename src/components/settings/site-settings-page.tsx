'use client';

// ============================================================================
// PULSE Workforce OS — Site Settings page (sidebar: Site Settings)
// ----------------------------------------------------------------------------
// Org-wide configuration — SUPER ADMIN ONLY (the sidebar hides the menu for
// normal admins and the page guards on top):
//
//   • General     — project display name (sidebar, browser title, auth
//                   screens) + company legal name (attendance paper)
//   • Appearance  — org-wide theme (dark/light) and accent, applied for every
//                   signed-in admin; the sidebar footer shortcuts write here
//   • AI Bot      — the in-app AI assistant connection: OpenAI-compatible
//                   base URL + API key (write-only, stored masked) + model,
//                   with a live Test connection button. The proxy route
//                   (/api/ai) never exposes the stored key to the browser.
//   • AI scope    — what the assistant will be able to read: EVERY entity of
//                   the system (A to Z), with live counts from the database
// ============================================================================

import {
  Bot, CheckCircle2, Building2, Loader2, Palette, PlugZap, Save, ShieldCheck,
  Sun, Moon, XCircle, Eye,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { dataApi, isDemoMode } from '@/lib/data';
import { db as demoDb } from '@/lib/data/demo-store';
import { buildAiKnowledgeBase } from '@/lib/ai/knowledge';
import type { AccentColor, SiteSettings, ThemeMode } from '@/lib/types';
import { fmtTimeAgo } from '@/lib/format';
import { useAuthStore } from '@/store/auth-store';
import { useSettingsStore } from '@/store/settings-store';
import { useRealtimeVersion } from '@/store/realtime';
import { cn } from '@/lib/utils';

const ACCENTS: { id: AccentColor; cls: string; label: string }[] = [
  { id: 'violet', cls: 'bg-violet-500', label: 'Violet' },
  { id: 'emerald', cls: 'bg-emerald-500', label: 'Emerald' },
  { id: 'amber', cls: 'bg-amber-500', label: 'Amber' },
  { id: 'rose', cls: 'bg-rose-500', label: 'Rose' },
];

/** Provider presets for the AI connection (OpenAI-compatible endpoints). */
const AI_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Z.ai GLM', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
];

const SCOPE_LABELS: Record<string, string> = {
  admins: 'Admin accounts',
  branches: 'Branches',
  sites: 'Sites',
  camps: 'Camps',
  employees: 'Employees',
  trades: 'Trades & rates',
  attendance_current_month: 'Attendance (this month)',
  salary_sheet_current_month: 'Salary sheet (this month)',
  advance_book: 'Advance records',
  leave_requests: 'Leave requests',
  cancellation_requests: 'Deletion requests',
  uniforms: 'Uniform entries',
  companies: 'Companies',
  card_types: 'Payroll card types',
  warnings: 'Warnings',
  fines: 'Fines',
  notifications: 'Notifications',
  deduction_settings: 'Deduction rule',
};

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; latencyMs: number; model: string; reply: string }
  | { kind: 'fail'; error: string };

export function SiteSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const settings = useSettingsStore((s) => s.settings);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.load);
  const updateSettings = useSettingsStore((s) => s.update);
  const settingsVersion = useRealtimeVersion(['site_settings']);
  const isSuperAdmin = user?.role === 'super_admin';

  // staged form values (seeded from the store; re-synced after realtime)
  const [projectName, setProjectName] = useState(settings.project_name);
  const [companyName, setCompanyName] = useState(settings.company_name);
  const [aiBaseUrl, setAiBaseUrl] = useState(settings.ai_base_url);
  const [aiModel, setAiModel] = useState(settings.ai_model);
  const [aiApiKey, setAiApiKey] = useState('');
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  // AI knowledge scope (entity → live row count)
  const [scope, setScope] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    loadSettings(true);
  }, [loadSettings, settingsVersion]);

  // re-seed the form whenever fresh settings arrive
  useEffect(() => {
    setProjectName(settings.project_name);
    setCompanyName(settings.company_name);
    setAiBaseUrl(settings.ai_base_url);
    setAiModel(settings.ai_model);
  }, [settings.project_name, settings.company_name, settings.ai_base_url, settings.ai_model]);

  // load the AI scope once (and when the underlying data changes)
  const dataVersion = useRealtimeVersion(['employee', 'site', 'attendance', 'payroll_period', 'advance_record']);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const kb = await buildAiKnowledgeBase();
        if (!cancelled) setScope(kb.counts);
      } catch { /* scope preview is optional */ }
    })();
    return () => { cancelled = true; };
  }, [dataVersion]);

  const meta = useMemo(() => {
    if (!settings.updated_at) return null;
    return {
      by: settings.updated_by_name ?? 'Unknown',
      ago: fmtTimeAgo(settings.updated_at),
    };
  }, [settings.updated_at, settings.updated_by_name]);

  // ---- access guard (sidebar already hides the menu for normal admins) -------
  if (!isSuperAdmin) {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck size={18} className="text-brand" /> Site Settings
            </CardTitle>
            <CardDescription>
              Only super admins can view and change the site settings.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // ---- save handlers ----------------------------------------------------------
  const saveGeneral = async () => {
    setSavingGeneral(true);
    try {
      await updateSettings({ project_name: projectName, company_name: companyName });
      toast.success('Branding saved', { description: 'The sidebar, browser title and attendance paper follow it.' });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the branding');
    } finally {
      setSavingGeneral(false);
    }
  };

  const applyTheme = async (theme: ThemeMode) => {
    try {
      await updateSettings({ theme });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change the theme');
    }
  };

  const applyAccent = async (accent: AccentColor) => {
    try {
      await updateSettings({ accent });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change the accent');
    }
  };

  const saveAi = async () => {
    setSavingAi(true);
    try {
      const patch: Parameters<typeof updateSettings>[0] = {
        ai_base_url: aiBaseUrl,
        ai_model: aiModel,
      };
      if (aiApiKey.trim()) patch.ai_api_key = aiApiKey.trim();
      await updateSettings(patch);
      setAiApiKey('');
      setTest({ kind: 'idle' });
      toast.success('AI connection saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the AI connection');
    } finally {
      setSavingAi(false);
    }
  };

  const toggleAi = async (enabled: boolean) => {
    try {
      await updateSettings({ ai_enabled: enabled });
      toast.success(enabled ? 'AI assistant enabled' : 'AI assistant disabled');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not toggle the AI assistant');
    }
  };

  const testConnection = async () => {
    setTest({ kind: 'running' });
    try {
      // demo mode: the stored raw key lives in the local demo store — prod
      // reads it server-side (the browser never sees it again)
      const storedKey = isDemoMode ? demoDb.siteSettings.ai_api_key : '';
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test',
          baseUrl: aiBaseUrl.trim(),
          apiKey: aiApiKey.trim() || storedKey,
          model: aiModel.trim(),
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string; latencyMs?: number; model?: string; reply?: string };
      if (json.ok) {
        setTest({ kind: 'ok', latencyMs: json.latencyMs ?? 0, model: json.model ?? aiModel, reply: json.reply ?? '' });
      } else {
        setTest({ kind: 'fail', error: json.error ?? 'The connection test failed' });
      }
    } catch {
      setTest({ kind: 'fail', error: 'Could not reach the /api/ai proxy on this server' });
    }
  };

  const generalDirty = projectName !== settings.project_name || companyName !== settings.company_name;
  const aiDirty = aiBaseUrl !== settings.ai_base_url || aiModel !== settings.ai_model || aiApiKey.trim() !== '';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* ---- page header ---- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Site Settings</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Org-wide configuration for the whole workforce system.
            {meta && (
              <> Last updated by <span className="font-medium text-foreground">{meta.by}</span> · {meta.ago}.</>
            )}
          </p>
        </div>
        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-500">
          <ShieldCheck size={12} className="mr-1" /> Super admin only
        </Badge>
      </div>

      {!settingsLoaded && (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Loading settings…
          </CardContent>
        </Card>
      )}

      {settingsLoaded && (
        <>
          {/* ---- General / branding ---- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 size={16} className="text-brand" /> General &amp; branding
              </CardTitle>
              <CardDescription>
                The project name shows in the sidebar, browser title and sign-in screens; the company
                legal name prints on the attendance paper header.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="project-name">Project name</Label>
                  <Input
                    id="project-name"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="PULSE Workforce"
                    maxLength={60}
                  />
                  <p className="text-[11px] text-muted-foreground">Shown everywhere the product is named.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="company-name">Company legal name</Label>
                  <Input
                    id="company-name"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="PULSE WORKFORCE OS LLC."
                    maxLength={120}
                  />
                  <p className="text-[11px] text-muted-foreground">Printed on the A4 attendance paper.</p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={saveGeneral} disabled={savingGeneral || !generalDirty} className="gap-1.5 font-semibold">
                  {savingGeneral ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  Save branding
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ---- Appearance ---- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Palette size={16} className="text-brand" /> Appearance
              </CardTitle>
              <CardDescription>
                The theme and accent apply to EVERY signed-in admin — the whole organization shares one look.
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
                      onClick={() => applyTheme(t.id)}
                      aria-pressed={settings.theme === t.id}
                      className={cn(
                        'flex items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                        settings.theme === t.id
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
                      {settings.theme === t.id && <CheckCircle2 size={16} className="ml-auto shrink-0 text-brand" />}
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
                      onClick={() => applyAccent(a.id)}
                      aria-pressed={settings.accent === a.id}
                      className={cn(
                        'flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 text-sm font-medium transition-all',
                        settings.accent === a.id
                          ? 'border-brand/50 bg-brand/10'
                          : 'border-border/60 hover:border-brand/30',
                      )}
                    >
                      <span className={cn('size-5 rounded-full', a.cls)} />
                      {a.label}
                      {settings.accent === a.id && <CheckCircle2 size={14} className="text-brand" />}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ---- AI assistant connection ---- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot size={16} className="text-brand" /> AI assistant
              </CardTitle>
              <CardDescription>
                Connection for the upcoming in-app AI bot. Any OpenAI-compatible endpoint works — pick a
                preset or enter a custom base URL. The API key is stored write-only and never shown again.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-brand/5 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Enable the AI assistant</p>
                  <p className="text-[11px] text-muted-foreground">
                    Requires a saved API key. The bot reads the whole database — see the scope below.
                  </p>
                </div>
                <Switch
                  checked={settings.ai_enabled}
                  onCheckedChange={toggleAi}
                  aria-label="Enable the AI assistant"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Presets:</span>
                {AI_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => { setAiBaseUrl(p.baseUrl); setAiModel(p.model); setTest({ kind: 'idle' }); }}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                      aiBaseUrl === p.baseUrl
                        ? 'border-brand/50 bg-brand/10 text-foreground'
                        : 'border-border/60 text-muted-foreground hover:border-brand/30 hover:text-foreground',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ai-base-url">Base URL</Label>
                  <Input
                    id="ai-base-url"
                    value={aiBaseUrl}
                    onChange={(e) => { setAiBaseUrl(e.target.value); setTest({ kind: 'idle' }); }}
                    placeholder="https://api.openai.com/v1"
                    inputMode="url"
                  />
                  <p className="text-[11px] text-muted-foreground">OpenAI-compatible /chat/completions endpoint.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-model">Model</Label>
                  <Input
                    id="ai-model"
                    value={aiModel}
                    onChange={(e) => { setAiModel(e.target.value); setTest({ kind: 'idle' }); }}
                    placeholder="gpt-4o-mini"
                  />
                  <p className="text-[11px] text-muted-foreground">Any model id your key can access.</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai-api-key">API key</Label>
                <Input
                  id="ai-api-key"
                  type="password"
                  autoComplete="off"
                  value={aiApiKey}
                  onChange={(e) => { setAiApiKey(e.target.value); setTest({ kind: 'idle' }); }}
                  placeholder={settings.ai_api_key_masked ? `${settings.ai_api_key_masked} — paste a new key to replace` : 'Paste your API key (sk-…)'}
                />
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Eye size={11} aria-hidden />
                  {settings.ai_api_key_masked
                    ? `A key is saved (${settings.ai_api_key_masked}). Leave this empty to keep it.`
                    : 'No key saved yet.'}
                </p>
              </div>

              {test.kind === 'ok' && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-semibold">
                      Connection OK — {test.latencyMs} ms · {test.model}
                    </p>
                    <p className="truncate text-xs opacity-80">Provider replied: “{test.reply}”</p>
                  </div>
                </div>
              )}
              {test.kind === 'fail' && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-sm text-rose-600 dark:text-rose-400">
                  <XCircle size={16} className="mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-semibold">Connection failed</p>
                    <p className="break-words text-xs opacity-80">{test.error}</p>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={testConnection}
                  disabled={test.kind === 'running' || !aiBaseUrl.trim() || !aiModel.trim()}
                  className="gap-1.5 font-semibold"
                >
                  {test.kind === 'running' ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}
                  Test connection
                </Button>
                <Button onClick={saveAi} disabled={savingAi || !aiDirty} className="gap-1.5 font-semibold">
                  {savingAi ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  Save AI connection
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ---- AI knowledge scope ---- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Eye size={16} className="text-brand" /> AI knowledge scope
              </CardTitle>
              <CardDescription>
                When the bot ships it will be able to read and query ALL of this data — every module of the
                system, A to Z. Counts are live from the database.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {scope === null ? (
                <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Measuring the database…
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {Object.entries(scope).map(([key, count]) => (
                    <div key={key} className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                      <p className="text-lg font-bold leading-tight">{count}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {SCOPE_LABELS[key] ?? key.replaceAll('_', ' ')}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                The AI receives the full application guide (payroll rules, advance cutting, attendance
                markers…) plus this live data snapshot with every question it answers.
              </p>
            </CardContent>
          </Card>

          <p className="pb-2 text-center text-[11px] text-muted-foreground">
            {isDemoMode
              ? 'Demo mode — settings persist in this browser (localStorage).'
              : 'Settings live in the site_settings table and propagate to every admin in realtime.'}
            {' '}Connection health for the AI proxy: <code className="rounded bg-muted px-1">POST /api/ai</code>.
          </p>
        </>
      )}
    </div>
  );
}
