'use client';

// ============================================================================
// PULSE Workforce OS — AI assistant floating chat widget
// ----------------------------------------------------------------------------
// A bubble button pinned to the bottom-right corner, visible for every
// signed-in admin while the AI assistant is ENABLED (Site Settings → AI Bot).
// Clicking the bubble opens a floating chat panel; clicking it again (or the
// panel's ✕ / Escape) collapses it — the conversation survives the collapse.
//
// The chat:
//   • the FIRST message builds the full knowledge base (every readable entity
//     of the database — see src/lib/ai/knowledge.ts) and caches it as the
//     system prompt for the session; "New chat" re-reads the database
//   • DEMO mode supplies the connection (base URL + key + model) from the
//     local demo store; SUPABASE mode sends no key — the /api/ai proxy reads
//     the stored connection server-side after verifying the caller
//   • answers render with light markdown (bold + inline code)
//   • without an API key the panel turns into a friendly pointer to the
//     Site Settings page (super admins jump straight there)
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot, Loader2, RotateCcw, SendHorizonal, Settings2, Sparkles, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isDemoMode } from '@/lib/data';
import { db as demoDb } from '@/lib/data/demo-store';
import { aiProxyHeaders } from '@/lib/ai/client';
import { buildAiKnowledgeBase, buildAiSystemPrompt } from '@/lib/ai/knowledge';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useSettingsStore } from '@/store/settings-store';
import { cn } from '@/lib/utils';

/** chat bubbles kept in the thread forwarded to the provider (the /api/ai
 *  proxy caps the whole conversation at 40 messages incl. the system prompt) */
const MAX_HISTORY = 24;

interface ChatBubble {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'How many employees are on the roster right now?',
  'Who was absent the most this month?',
  'Explain the absent-deduction rule in simple terms',
];

/** Light inline markdown: **bold** and `code` spans (React escapes the rest). */
function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 5) {
          return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 3) {
          return (
            <code key={i} className="rounded bg-background/70 px-1 py-0.5 font-mono text-[11px]">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function AiChatWidget() {
  const user = useAuthStore((s) => s.user);
  const settings = useSettingsStore((s) => s.settings);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const navigateTo = useAppStore((s) => s.navigateTo);

  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const systemPromptRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // keep the thread glued to the newest message
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, preparing, sending, open]);

  // Escape collapses the panel
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // hidden unless a user is signed in AND the org enabled the assistant
  if (!user || !settingsLoaded || !settings.ai_enabled) return null;

  const hasKey = settings.ai_api_key_masked !== '';
  const isSuperAdmin = user.role === 'super_admin';

  const toggle = () => setOpen((prev) => {
    const next = !prev;
    if (next) setHasOpened(true);
    return next;
  });

  const resetChat = () => {
    if (sending || preparing) return;
    setMessages([]);
    setError(null);
    systemPromptRef.current = null; // the next message re-reads the database
  };

  const autoSize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  };

  /** Build (once per session) the A→Z database knowledge system prompt. */
  const ensureSystemPrompt = async (): Promise<string> => {
    if (systemPromptRef.current) return systemPromptRef.current;
    setPreparing(true);
    try {
      const kb = await buildAiKnowledgeBase();
      systemPromptRef.current = buildAiSystemPrompt(kb, settings);
      return systemPromptRef.current;
    } finally {
      setPreparing(false);
    }
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || sending || preparing) return;
    if (!hasKey) {
      setError('The AI connection has no API key yet — set it on the Site Settings page.');
      return;
    }
    setError(null);
    const bubble: ChatBubble = { role: 'user', content: text };
    setMessages((m) => [...m, bubble]);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setSending(true);
    try {
      const system = await ensureSystemPrompt();
      const history = [...messages, bubble]
        .slice(-MAX_HISTORY)
        .map(({ role, content }) => ({ role, content }));
      const body: Record<string, unknown> = {
        action: 'chat',
        baseUrl: settings.ai_base_url,
        model: settings.ai_model,
        // demo mode: the raw key lives in the local demo store; in Supabase
        // mode no key is sent — the proxy reads the stored one server-side
        ...(isDemoMode ? { apiKey: demoDb.siteSettings.ai_api_key } : {}),
        messages: [{ role: 'system', content: system }, ...history],
        maxTokens: 1024,
        temperature: 0.3,
      };
      const res = await fetch('/api/ai', {
        method: 'POST',
        // Supabase mode: the bearer token lets the proxy verify the caller
        // and read the STORED connection (key stays server-side)
        headers: await aiProxyHeaders(),
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok: boolean; reply?: string; error?: string };
      if (!json.ok || typeof json.reply !== 'string') {
        throw new Error(json.error || 'The assistant could not answer that.');
      }
      setMessages((m) => [...m, { role: 'assistant', content: json.reply as string }]);
    } catch (e) {
      // roll the optimistic bubble back and hand the text back for editing
      setMessages((m) => (m[m.length - 1] === bubble ? m.slice(0, -1) : m));
      setInput(text);
      setError(e instanceof Error ? e.message : 'The chat request failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* ---- floating chat panel ---- */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="ai-panel"
            role="dialog"
            aria-label="AI assistant chat"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: 'bottom right' }}
            className="fixed bottom-[5.75rem] right-5 z-50 flex h-[min(34rem,72dvh)] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
          >
            {/* header */}
            <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-3">
              <div className="relative flex size-9 shrink-0 items-center justify-center rounded-xl brand-gradient text-brand-foreground">
                <Bot className="size-5" />
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold leading-tight">AI Assistant</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {hasKey ? `Knows the whole database · ${settings.ai_model}` : 'Connection not configured'}
                </p>
              </div>
              <Button
                variant="ghost" size="icon" className="size-8 shrink-0" onClick={resetChat}
                disabled={messages.length === 0 || sending || preparing} aria-label="Start a new chat"
                title="New chat (re-reads the database)"
              >
                <RotateCcw className="size-4" />
              </Button>
              <Button
                variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => setOpen(false)}
                aria-label="Collapse the chat panel"
              >
                <X className="size-4" />
              </Button>
            </div>

            {/* thread */}
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 && !preparing ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl brand-gradient text-brand-foreground shadow-lg">
                    <Sparkles className="size-6" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Ask me anything about {settings.project_name}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      I can read the entire database — employees, sites, attendance, payroll, advances and more.
                    </p>
                  </div>
                  <div className="mt-1 flex w-full flex-col gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s} type="button" onClick={() => void send(s)}
                        className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((m, i) => (
                    <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed',
                          m.role === 'user'
                            ? 'brand-gradient rounded-br-md text-brand-foreground shadow-sm'
                            : 'rounded-bl-md bg-muted text-foreground',
                        )}
                      >
                        <InlineMarkdown text={m.content} />
                      </div>
                    </div>
                  ))}
                  {(preparing || sending) && (
                    <div className="flex justify-start">
                      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-[13px] text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        {preparing ? 'Reading the database…' : 'Thinking…'}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* composer — or a friendly pointer when the key is missing */}
            {!hasKey ? (
              <div className="border-t border-border px-4 py-4 text-center">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The AI connection has no API key yet.{' '}
                  {isSuperAdmin
                    ? 'Set the provider, API key and model on the Site Settings page.'
                    : 'Ask a super admin to configure it on the Site Settings page.'}
                </p>
                {isSuperAdmin && (
                  <Button
                    variant="outline" size="sm" className="mt-2"
                    onClick={() => {
                      setOpen(false);
                      navigateTo('site_settings');
                    }}
                  >
                    <Settings2 className="size-3.5" /> Open Site Settings
                  </Button>
                )}
              </div>
            ) : (
              <div className="border-t border-border p-3">
                {error && (
                  <p className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </p>
                )}
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    ref={taRef}
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      autoSize();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    rows={1}
                    placeholder="Ask about employees, payroll…"
                    className="min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-[13px] leading-snug outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                  />
                  <Button
                    type="submit" size="icon" aria-label="Send message"
                    className="size-10 shrink-0 rounded-xl brand-gradient text-brand-foreground"
                    disabled={!input.trim() || sending || preparing}
                  >
                    {sending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizonal className="size-4" />}
                  </Button>
                </form>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- floating bubble button (bottom-right) ---- */}
      <motion.button
        type="button"
        onClick={toggle}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        aria-label={open ? 'Collapse the AI assistant' : 'Open the AI assistant'}
        className="fixed bottom-5 right-5 z-50 flex size-14 items-center justify-center rounded-full brand-gradient text-brand-foreground shadow-xl shadow-black/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {!hasOpened && !open && (
          <span className="absolute inset-0 animate-ping rounded-full brand-gradient opacity-50" aria-hidden />
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={open ? 'close' : 'bot'}
            initial={{ rotate: -60, opacity: 0 }}
            animate={{ rotate: 0, opacity: 1 }}
            exit={{ rotate: 60, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="flex"
          >
            {open ? <X className="size-6" /> : <Bot className="size-6" />}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </>
  );
}
