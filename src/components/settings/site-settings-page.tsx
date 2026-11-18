'use client';

// ============================================================================
// PULSE Workforce OS — Site Settings page (sidebar: Site Settings)
// ----------------------------------------------------------------------------
// Org-wide configuration — SUPER ADMIN ONLY (the sidebar hides the menu for
// normal admins and the page guards on top):
//
//   • General     — project display name (sidebar, browser title, auth
//                   screens), company legal name (attendance paper) and the
//                   company LOGO (sidebar, sign-in screen, browser favicon)
//   • Appearance  — org-wide theme (dark/light) and accent, applied for every
//                   signed-in admin; the sidebar footer shortcuts write here
//   • AI Bot      — the in-app AI assistant connection: OpenAI-compatible
//                   base URL + API key (write-only, stored masked) + model,
//                   with presets AND a fully custom provider option, plus a
//                   live Test connection button. The proxy route (/api/ai)
//                   never exposes the stored key to the browser.
//   • AI scope    — what the assistant will be able to read: EVERY entity of
//                   the system (A to Z), with live counts from the database
// ============================================================================

import {
  Bot, CheckCircle2, Building2, Image as ImageIcon, Loader2, Palette, PlugZap, Plus, Save, ShieldCheck,
  Sun, Moon, XCircle, Eye, Upload, Trash2,
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
import { aiProxyHeaders } from '@/lib/ai/client';
import { BOT_TITLE, buildAiKnowledgeBase } from '@/lib/ai/knowledge';
import { resolveAiScope } from '@/lib/ai/scope';
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
  employees: 'Employees (roster)',
  cancelled_employees: 'Cancelled employees',
  trades: 'Trades & rates',
  attendance_current_month: 'Attendance (this month)',
  salary_sheet_current_month: 'Salary sheet (this month)',
  advance_book: 'Advance records',
  leave_requests: 'Leave requests',
  cancellation_requests: 'Cancellation requests',
  uniforms: 'Uniform entries',
  companies: 'Companies',
  card_types: 'Payroll card types',
  warnings: 'Warnings',
  fines: 'Fines',
  notifications: 'Notifications',
  deduction_settings: 'Deduction rule',
  site_documents: 'Site documents (timesheets & time cards)',
};

/** Read an image file → a compact square-fitting PNG data URL (max 256px) —
 *  small enough to persist inside the settings row and render instantly. */
function fileToLogoDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please choose an image file (PNG, JPG, WEBP, SVG…)'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('Image is too large — use a file under 5 MB'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error('Could not load the image'));
      img.onload = () => {
        const max = 256;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas is not available in this browser')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

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
  // staged logo: '' = default PULSE mark, otherwise a data:/https: URL
  const [logoUrl, setLogoUrl] = useState(settings.logo_url ?? '');
  const [logoBusy, setLogoBusy] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState(settings.ai_base_url);
  const [aiModel, setAiModel] = useState(settings.ai_model);
  const [aiApiKey, setAiApiKey] = useState('');
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  // AI provider mode — true after the Custom chip is clicked (until a preset
  // is picked), so the chip + helper text stay visible while typing
  const [customProviderMode, setCustomProviderMode] = useState(false);
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
    setLogoUrl(settings.logo_url ?? '');
    setAiBaseUrl(settings.ai_base_url);
    setAiModel(settings.ai_model);
  }, [settings.project_name, settings.company_name, settings.logo_url, settings.ai_base_url, settings.ai_model]);

  // load the AI scope once (and when the underlying data changes)
  const dataVersion = useRealtimeVersion(['employee', 'site', 'attendance', 'payroll_period', 'advance_record']);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // this page is super-admin-only → the scope resolves unrestricted
        // (the preview shows everything Pebby can be given by the settings)
        const aiScope = await resolveAiScope(user, null);
        const kb = await buildAiKnowledgeBase(aiScope);
        if (!cancelled) setScope(kb.counts);
      } catch { /* scope preview is optional */ }
    })();
    return () => { cancelled = true; };
  }, [dataVersion, user]);

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
      await updateSettings({
        project_name: projectName,
        company_name: companyName,
        logo_url: logoUrl,
      });
      toast.success('Branding saved', { description: 'The sidebar, browser title, sign-in screen and attendance paper follow it.' });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the branding');
    } finally {
      setSavingGeneral(false);
    }
  };

  const pickLogo = async (file: File | null) => {
    if (!file) return;
    setLogoBusy(true);
    try {
      const dataUrl = await fileToLogoDataUrl(file);
      setLogoUrl(dataUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read the image');
    } finally {
      setLogoBusy(false);
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
      toast.success(enabled ? `${BOT_TITLE} enabled` : `${BOT_TITLE} disabled`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not toggle the AI assistant');
    }
  };

  const testConnection = async () => {
    setTest({ kind: 'running' });
    try {
      // demo mode: the stored raw key lives in the local demo store — prod
      // sends the caller's token so the proxy can fall back to the STORED key
      // (the raw key never returns to the browser)
      const storedKey = isDemoMode ? demoDb.siteSettings.ai_api_key : '';
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: await aiProxyHeaders(),
        body: JSON.stringify({
          action: 'test',
          baseUrl: aiBaseUrl.trim(),
          apiKey: aiApiKey.trim() || storedKey,
          model: aiModel.trim(),
        }),
      });
      // the platform can answer a too-long request with an HTML error page —
      // parse defensively instead of throwing "Unexpected token <"
      let json: { ok: boolean; error?: string; latencyMs?: number; model?: string; reply?: string } | null = null;
      try {
        json = (await res.json()) as { ok: boolean; error?: string; latencyMs?: number; model?: string; reply?: string };
      } catch {
        json = null;
      }
      if (json && json.ok) {
        setTest({ kind: 'ok', latencyMs: json.latencyMs ?? 0, model: json.model ?? aiModel, reply: json.reply ?? '' });
      } else {
        setTest({ kind: 'fail', error: json?.error ?? 'The connection test failed — the host may have cut the request off. Please try again.' });
      }
    } catch {
      setTest({ kind: 'fail', error: 'Could not reach the /api/ai proxy on this server' });
    }
  };

  const generalDirty = projectName !== settings.project_name
    || companyName !== settings.company_name
    || logoUrl !== (settings.logo_url ?? '');
  const aiDirty = aiBaseUrl !== settings.ai_base_url || aiModel !== settings.ai_model || aiApiKey.trim() !== '';
  // a preset chip is active when the staged URL matches it; the CUSTOM chip
  // is active when a non-preset URL is staged (any OpenAI-compatible endpoint)
  // or right after it was picked (before anything is typed)
  const isPresetUrl = (u: string) => AI_PRESETS.some((p) => p.baseUrl === u);
  const customProviderActive = aiBaseUrl.trim()
    ? !isPresetUrl(aiBaseUrl.trim())
    : customProviderMode;

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
                legal name prints on the attendance paper header; the logo replaces the default PULSE
                mark in the sidebar, on the sign-in screen and as the browser favicon.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* company logo — upload / preview / remove */}
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border/60 bg-brand/5 p-4">
                <div className="relative shrink-0">
                  <div className={cn('absolute inset-0 rounded-xl blur-md', logoUrl ? 'opacity-0' : 'brand-gradient opacity-40')} />
                  {logoUrl ? (
                    // staged custom logo (data URL / https) — plain <img>: it can
                    // be a data URL, which next/image does not optimize
                    <img src={logoUrl} alt="Company logo" className="relative size-14 rounded-xl border border-border/60 bg-background object-contain p-1" />
                  ) : (
                    <div className="relative flex size-14 items-center justify-center rounded-xl border border-border/60 bg-background">
                      <ImageIcon size={22} className="text-muted-foreground" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">Company logo</p>
                  <p className="text-[11px] text-muted-foreground">
                    {logoUrl ? 'Custom logo staged — save branding to apply it.' : 'Using the default PULSE mark. PNG / JPG / WEBP / SVG up to 5 MB.'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="outline" size="sm"
                      disabled={logoBusy}
                      onClick={() => document.getElementById('logo-file-input')?.click()}
                      className="gap-1.5 font-medium"
                    >
                      {logoBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                      {logoUrl ? 'Replace image' : 'Upload logo'}
                    </Button>
                    {logoUrl && (
                      <Button
                        variant="outline" size="sm"
                        onClick={() => setLogoUrl('')}
                        className="gap-1.5 font-medium text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
                      >
                        <Trash2 size={14} /> Remove
                      </Button>
                    )}
                    {/* hidden native picker — the styled buttons drive it */}
                    <input
                      id="logo-file-input" type="file" accept="image/*" className="hidden"
                      onChange={(e) => { pickLogo(e.target.files?.[0] ?? null); e.target.value = ''; }}
                    />
                  </div>
                </div>
              </div>
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

          {/* ---- Appearance (org defaults) ---- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Palette size={16} className="text-brand" /> Default Appearance
              </CardTitle>
              <CardDescription>
                The organisation&apos;s default look — applied to the sign-in screen and the starting
                theme for new admins. Once signed in, every admin personalises their own theme &amp;
                accent from My Settings (it follows their account, not these defaults).
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

          {/* ---- Pebby (AI assistant) connection ---- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot size={16} className="text-brand" /> {BOT_TITLE}
              </CardTitle>
              <CardDescription>
                Connection for Pebby, the in-app AI bot. Pick a preset or switch to a CUSTOM provider
                and point it at any OpenAI-compatible endpoint (Groq, Together, DeepSeek, Ollama, LM
                Studio, your own gateway…). The API key is stored write-only and never shown again.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-brand/5 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Enable {BOT_TITLE}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Requires a saved API key. Pebby searches the whole database on every question — see the scope below.
                  </p>
                </div>
                <Switch
                  checked={settings.ai_enabled}
                  onCheckedChange={toggleAi}
                  aria-label="Enable Pebby — Smart Assistant"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Provider:</span>
                {AI_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => { setAiBaseUrl(p.baseUrl); setAiModel(p.model); setCustomProviderMode(false); setTest({ kind: 'idle' }); }}
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
                {/* CUSTOM provider — any OpenAI-compatible endpoint */}
                <button
                  type="button"
                  aria-pressed={customProviderActive}
                  onClick={() => {
                    setTest({ kind: 'idle' });
                    // clear preset values so free entry starts from scratch;
                    // a custom URL typed already just gets highlighted
                    if (!customProviderActive) {
                      setAiBaseUrl('');
                      setAiModel('');
                      setCustomProviderMode(true);
                      document.getElementById('ai-base-url')?.focus();
                    }
                  }}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    customProviderActive
                      ? 'border-brand/50 bg-brand/10 text-foreground'
                      : 'border-dashed border-border/60 text-muted-foreground hover:border-brand/30 hover:text-foreground',
                  )}
                >
                  <Plus size={11} /> Custom
                </button>
              </div>
              {customProviderActive && (
                <p className="rounded-lg border border-brand/25 bg-brand/5 px-3 py-2 text-xs text-muted-foreground">
                  Custom provider — enter the base URL and model of any OpenAI-compatible API below
                  (e.g. https://api.groq.com/openai/v1 + llama-3.3-70b-versatile, or your self-hosted
                  gateway). The Test connection button validates it before you save.
                </p>
              )}

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

          {/* ---- Pebby's knowledge scope ---- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Eye size={16} className="text-brand" /> Pebby&apos;s knowledge scope
              </CardTitle>
              <CardDescription>
                Pebby reads and queries ALL of this data — every module of the system, A to Z — with
                every question it answers. Counts are live from the database.
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
                With every question, Pebby receives the full application guide (payroll rules, advance
                cutting, attendance markers…) plus a fresh live data snapshot — and can fetch deeper
                records or research the web on demand.
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
