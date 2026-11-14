// ============================================================================
// PULSE Workforce OS — AI proxy (/api/ai)
// ----------------------------------------------------------------------------
// Server-side bridge for the AI assistant configured on the Site Settings
// page (OpenAI-compatible base URL + API key + model). Actions:
//
//   test — pings the provider with the given (or stored) connection and
//          reports success / latency. Used by the settings page button.
//   chat — forwards a chat conversation to the provider. Foundation for the
//          in-app AI bot: in SUPABASE mode the key never reaches the browser
//          (it is read from site_settings with the service-role key after the
//          caller is verified); in DEMO mode the caller supplies the
//          connection from its local demo store.
//
// Security: same-origin only, http(s) base URLs, hard caps on sizes and a
// 45s timeout. The raw API key is never logged.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AiRequestBody {
  action: 'test' | 'chat';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 24_000;
const MAX_TOKENS_CAP = 4096;

function bad(error: string, status = 400): Response {
  return Response.json({ ok: false, error }, { status });
}

/** https://provider.example/v1 → https://provider.example/v1/chat/completions
 *  (already-complete endpoints pass through untouched). */
function chatCompletionsUrl(base: string): URL | null {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const full = /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
    return new URL(full);
  } catch {
    return null;
  }
}

async function callProvider(
  url: URL,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<{ reply: string; usage: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
      usage?: unknown;
    } | null;
    if (!res.ok) {
      const detail = body?.error?.message ?? `Provider answered with HTTP ${res.status}`;
      throw new Error(detail);
    }
    const reply = body?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') throw new Error('Provider returned no answer (unexpected response shape)');
    return { reply, usage: body?.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<Response> {
  // --- same-origin guard -----------------------------------------------------
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return bad('Cross-origin requests are not allowed', 403);
    } catch {
      return bad('Invalid origin', 403);
    }
  }

  let body: AiRequestBody;
  try {
    body = (await request.json()) as AiRequestBody;
  } catch {
    return bad('Invalid JSON body');
  }
  if (body.action !== 'test' && body.action !== 'chat') return bad('Unknown action');

  // --- resolve the connection -------------------------------------------------
  // Supabase mode: chat uses the STORED settings (key read server-side);
  // test prefers the caller-supplied values so unsaved edits can be tested,
  // falling back to the stored key (super admins only).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isSupabase = Boolean(supabaseUrl && anonKey && serviceKey);

  let baseUrl = (body.baseUrl ?? '').trim();
  let apiKey = (body.apiKey ?? '').trim();
  let model = (body.model ?? '').trim();

  const readStored = async (): Promise<{ base: string; key: string; model: string } | null> => {
    if (!isSupabase) return null;
    const bearer = request.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    if (!bearer) return null;
    const caller = createClient(supabaseUrl!, anonKey!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: isSuper } = await caller.rpc('is_super_admin');
    if (!isSuper) return null;
    const admin = createClient(supabaseUrl!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin
      .from('site_settings')
      .select('ai_base_url, ai_model, ai_api_key')
      .eq('id', 1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      base: String(data.ai_base_url ?? ''),
      key: String(data.ai_api_key ?? ''),
      model: String(data.ai_model ?? ''),
    };
  };

  if (!baseUrl || !apiKey || !model) {
    const stored = await readStored();
    if (stored) {
      baseUrl = baseUrl || stored.base;
      apiKey = apiKey || stored.key;
      model = model || stored.model;
    }
  }

  if (!baseUrl) return bad('Missing AI base URL — set it on the Site Settings page');
  if (!model) return bad('Missing AI model — set it on the Site Settings page');
  if (!apiKey) {
    return bad('No API key available — paste one on the Site Settings page first');
  }

  const url = chatCompletionsUrl(baseUrl);
  if (!url) return bad('AI base URL must be a valid http(s) URL, e.g. https://api.openai.com/v1');

  // --- run the action ----------------------------------------------------------
  try {
    if (body.action === 'test') {
      const started = Date.now();
      const { reply } = await callProvider(
        url, apiKey, model,
        [{ role: 'user', content: 'Reply with exactly one word: pong' }],
        16, 0,
      );
      return Response.json({
        ok: true,
        latencyMs: Date.now() - started,
        model,
        reply: reply.trim().slice(0, 120),
      });
    }

    // chat — validate + forward the conversation
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) return bad('messages[] is required for chat');
    if (messages.length > MAX_MESSAGES) return bad(`Too many messages (max ${MAX_MESSAGES})`);
    for (const m of messages) {
      if (!m || typeof m.content !== 'string') return bad('Every message needs string content');
      if (!['system', 'user', 'assistant'].includes(m.role)) return bad('Invalid message role');
      if (m.content.length > MAX_CONTENT_CHARS) return bad('A message exceeds the size limit');
    }
    const maxTokens = Math.min(Math.max(1, Math.round(body.maxTokens ?? 1024)), MAX_TOKENS_CAP);
    const temperature = Math.min(Math.max(0, body.temperature ?? 0.3), 2);

    const { reply, usage } = await callProvider(url, apiKey, model, messages, maxTokens, temperature);
    return Response.json({ ok: true, model, reply, usage });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The AI request failed';
    const aborted = err instanceof Error && err.name === 'AbortError';
    return Response.json(
      { ok: false, error: aborted ? 'The provider timed out after 45s — check the base URL and key' : message },
      { status: 502 },
    );
  }
}
