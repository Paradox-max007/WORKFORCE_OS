// ============================================================================
// PULSE Workforce OS — AI proxy (/api/ai)
// ----------------------------------------------------------------------------
// Server-side bridge for Pebby, the in-app Smart Assistant configured on the
// Site Settings page (OpenAI-compatible base URL + API key + model). Actions:
//
//   test — pings the provider with the given (or stored) connection and
//          reports success / latency. Used by the settings page button.
//   chat — forwards a chat conversation to the provider. Powers the floating
//          in-app AI bot: in SUPABASE mode the key never reaches the browser
//          (it is read from site_settings with the service-role key after the
//          caller is verified — any signed-in admin may CHAT through the
//          stored connection, while the stored-key fallback for 'test' stays
//          super-admin only); in DEMO mode the caller supplies the
//          connection from its local demo store.
//
//          WEB RESEARCH: when the model decides a question is outside the
//          workforce database it replies with a [[WEB: query]] directive;
//          the proxy searches the web (DuckDuckGo Instant Answers +
//          Wikipedia — keyless public APIs), appends the results and re-asks
//          the provider, then returns the final answer. Works with any
//          OpenAI-compatible provider — no tool-calling support needed.
//
// Security: same-origin only, http(s) base URLs, hard caps on sizes and a
// 45s per-call timeout. The raw API key is never logged.
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
/** the system prompt carries the whole compact database snapshot, so the
 *  per-message ceiling is generous (≈ 150k chars ≈ 40k tokens) */
const MAX_CONTENT_CHARS = 150_000;
const MAX_TOKENS_CAP = 4096;

/** Directive the model uses to request web research: [[WEB: query]] */
const WEB_DIRECTIVE = /\[\[WEB:\s*([^\]]+?)\s*\]\]/i;
const WEB_DIRECTIVE_ALL = /\[\[WEB:\s*[^\]]+?\s*\]\]/gi;

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

// ---------------------------------------------------------------------------
// Web research — keyless public endpoints, all fetched server-side:
//   1. Google News RSS  — current affairs / news questions
//   2. Bing RSS         — general web search results
//   3. Wikipedia API    — encyclopedic answers (policy-compliant UA with
//                         contact info, otherwise Wikimedia answers 403)
// Composed into one results block for the model. Every tier degrades
// gracefully — an unreachable source is simply skipped.
// ---------------------------------------------------------------------------

/** Wikimedia requires a descriptive User-Agent with contact information. */
const WEB_UA = 'PULSE-WorkforceOS/1.0 (workforce management app; contact: admin@pulse.app)';

async function fetchWeb(url: string, timeoutMs = 8_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': WEB_UA, Accept: '*/*' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

interface RssItem { title: string; link: string; date: string | null; desc: string | null }

/** Parse the <item> blocks of an RSS document (Google News / Bing format). */
function parseRssItems(xml: string, limit: number): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && items.length < limit) {
    const block = m[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1];
    const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1];
    const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? null;
    const desc = /<description>([\s\S]*?)<\/description>/.exec(block)?.[1] ?? null;
    if (title && link) {
      items.push({
        title: decodeEntities(title).slice(0, 200),
        link: decodeEntities(link),
        date: date ? decodeEntities(date) : null,
        desc: desc ? decodeEntities(desc).slice(0, 300) : null,
      });
    }
  }
  return items;
}

/** Search Google News (RSS) + Bing (RSS) + Wikipedia and compose a block. */
async function webSearch(query: string): Promise<string> {
  const q = query.trim().slice(0, 200);
  if (!q) return 'No web results (empty query).';

  const [newsXml, bingXml, wikiSearchRaw] = await Promise.all([
    fetchWeb(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`),
    fetchWeb(`https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`),
    fetchWeb(`https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=3&srsearch=${encodeURIComponent(q)}`),
  ]);

  const blocks: string[] = [];

  // 1. Google News — current affairs
  const news = newsXml ? parseRssItems(newsXml, 6) : [];
  if (news.length > 0) {
    blocks.push(`Google News (newest first):\n${news.map((n) => `- ${n.title}${n.date ? ` (${n.date})` : ''} — ${n.link}`).join('\n')}`);
  }

  // 2. Bing — general web results
  const bing = bingXml ? parseRssItems(bingXml, 6) : [];
  if (bing.length > 0) {
    blocks.push(`Bing web results:\n${bing.map((b) => `- ${b.title}${b.desc ? `: ${b.desc}` : ''} — ${b.link}`).join('\n')}`);
  }

  // 3. Wikipedia — encyclopedic context (search + intro extracts)
  try {
    const ws = wikiSearchRaw ? JSON.parse(wikiSearchRaw) as { query?: { search?: { title: string; snippet?: string }[] } } : null;
    const hits = ws?.query?.search ?? [];
    if (hits.length > 0) {
      const titles = hits.map((h) => h.title).join('|');
      const extractsRaw = await fetchWeb(
        `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(titles)}`,
      );
      const ex = extractsRaw ? JSON.parse(extractsRaw) as { query?: { pages?: Record<string, { title?: string; extract?: string }> } } : null;
      const pages = Object.values(ex?.query?.pages ?? {});
      const wikiLines: string[] = [];
      hits.forEach((h) => {
        const page = pages.find((p) => p.title === h.title);
        const text = (page?.extract ?? h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
        if (text) wikiLines.push(`- ${h.title} (en.wikipedia.org/wiki/${encodeURIComponent(h.title.replaceAll(' ', '_'))}): ${text}`);
      });
      if (wikiLines.length) blocks.push(`Wikipedia:\n${wikiLines.join('\n')}`);
    }
  } catch {
    // a malformed Wikipedia response never breaks the whole search
  }

  if (blocks.length === 0) {
    return 'No usable web results were found for this query.';
  }
  return blocks.join('\n\n').slice(0, 12_000);
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

  const readStored = async (requireSuper: boolean): Promise<{ base: string; key: string; model: string } | null> => {
    if (!isSupabase) return null;
    const bearer = request.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    if (!bearer) return null;
    const caller = createClient(supabaseUrl!, anonKey!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (requireSuper) {
      // stored-key fallback for 'test' — super admins only
      const { data: isSuper } = await caller.rpc('is_super_admin');
      if (!isSuper) return null;
    } else {
      // 'chat' — every signed-in admin may use the stored connection; the
      // raw key itself is only ever read server-side
      const { data: { user: callerUser } } = await caller.auth.getUser();
      if (!callerUser) return null;
    }
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
    // 'test' falls back to the stored connection for super admins only;
    // 'chat' may use it as any signed-in admin (key stays server-side)
    const stored = await readStored(body.action === 'test');
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

    let { reply, usage } = await callProvider(url, apiKey, model, messages, maxTokens, temperature);

    // --- web research round: the model asked for [[WEB: query]] ----------
    // One round only — the follow-up must be a final answer. Any directive
    // tokens surviving in the final reply are stripped so the protocol never
    // leaks into the chat UI.
    const webMatch = reply.match(WEB_DIRECTIVE);
    if (webMatch) {
      const query = webMatch[1].trim();
      const research = await webSearch(query);
      const researched: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: reply },
        {
          role: 'user',
          content: `WEB RESEARCH for "${query}" (fetched just now, ${new Date().toISOString()}):\n${research}\n\n( system-provided research — now answer the user's question using these results; briefly mention the source(s); if the results are thin or irrelevant, say you could not verify current data and answer from general knowledge; do not print any directive )`,
        },
      ];
      const second = await callProvider(url, apiKey, model, researched, maxTokens, temperature);
      reply = second.reply.replace(WEB_DIRECTIVE_ALL, '').trim();
      usage = second.usage ?? usage;
    } else {
      reply = reply.replace(WEB_DIRECTIVE_ALL, '').trim();
    }

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
