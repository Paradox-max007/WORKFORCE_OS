'use client';

// ============================================================================
// PULSE Workforce OS — Pebby, the floating Smart Assistant
// ----------------------------------------------------------------------------
// A bubble button pinned to the bottom-right corner, visible for every
// signed-in admin while the AI assistant is ENABLED (Site Settings → AI Bot).
// Clicking the bubble opens a floating chat panel; clicking it again (or the
// panel's ✕ / Escape) collapses it — the conversation survives the collapse.
//
// The panel is fully responsive: phones get a full-screen sheet (safe-area
// aware, launcher hidden while open), tablets a tall floating panel above the
// bubble, and desktops a wide chat window (38–42rem) with larger text,
// roomier spacing and 2-column suggestion chips.
//
// The chat:
//   • EVERY question rebuilds the knowledge base from the live database
//     (see src/lib/ai/knowledge.ts) — a real database search per message —
//     LIMITED to the viewer's access scope (src/lib/ai/scope.ts): a branch
//     admin's Pebby sees only their granted branches + directly assigned
//     sites; super admins / All-Branches admins see everything
//   • when Pebby needs deeper records it replies with a [[LOOKUP]]
//     directive; the widget fetches the rows (full employee documents,
//     other attendance / salary months) and re-asks
//   • complex questions run through the [[QUERY]] engine (src/lib/ai/
//     query-engine.ts): the model asks for filtered / sorted / grouped /
//     aggregated views of ANY table — employees, cancellation requests,
//     advances, trade rates, past months… — the widget executes the query
//     and re-asks, so Pebby answers questions like "when was Hassan
//     cancelled" with the exact reviewed_at timestamp
//   • up to 3 directive rounds per question (LOOKUP + QUERY combined), so
//     Pebby can chain queries across tables before answering
//   • assistant answers render as rich markdown BLOCKS — pipe tables become
//     real GUI tables that scroll inside the bubble (wide → horizontal,
//     long → vertical with a sticky header), plus proper lists/headings
//   • off-topic questions are routed by the /api/ai proxy: it sees the
//     [[WEB: query]] directive, researches the web (news RSS + Wikipedia)
//     and re-asks the provider, so Pebby answers current affairs too
//   • the connection (base URL + key + model) comes from Site Settings —
//     demo mode supplies the key from the local demo store, Supabase mode
//     keeps it server-side (aiProxyHeaders)
// ============================================================================

import { AnimatePresence, motion } from 'framer-motion';
import {
  Loader2, RotateCcw, SendHorizonal, Settings2, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PebbleAvatar } from '@/components/ai/pebby-avatar';
import { Button } from '@/components/ui/button';
import { dataApi, isDemoMode } from '@/lib/data';
import { db as demoDb } from '@/lib/data/demo-store';
import { aiProxyHeaders } from '@/lib/ai/client';
import {
  BOT_NAME, buildAiKnowledgeBase, buildAiSystemPrompt,
  formatAttendanceMonth, formatEmployeeDeepDive, formatSalarySheetPeriod,
  formatSiteDocuments,
} from '@/lib/ai/knowledge';
import { describeScope, resolveAiScope, type AiScope } from '@/lib/ai/scope';
import { extractSiteDocText, formatSiteDocContent } from '@/lib/files/doc-content';
import { listSiteDocs, monthsSince, type SiteDocKind } from '@/lib/files/site-docs';
import {
  parseAiQueryDirective, runAiQuery, type AiQuerySpec,
} from '@/lib/ai/query-engine';
import type { Attendance, EmployeeVM, SalarySheetReport } from '@/lib/types';
import { useAppStore } from '@/store/app-store';
import { useAuthStore } from '@/store/auth-store';
import { useSettingsStore } from '@/store/settings-store';
import { cn } from '@/lib/utils';

/** chat bubbles kept in the thread forwarded to the provider (the /api/ai
 *  proxy caps the whole conversation at 40 messages incl. the system prompt) */
const MAX_HISTORY = 24;

/** max [[LOOKUP]] / [[QUERY]] rounds per question — enough to chain across
 *  tables (name → code → records → aggregate) */
const MAX_LOOKUP_HOPS = 3;

interface ChatBubble {
  role: 'user' | 'assistant';
  content: string;
}

/** One parsed [[LOOKUP]] directive (the model replies with exactly one). */
interface LookupDirective {
  kind: 'employees' | 'attendance' | 'salary' | 'site-docs' | 'doc-content';
  codes?: string[];
  month?: string; // YYYY-MM
  siteName?: string; // free-text site name (site-docs / doc-content)
  docKind?: SiteDocKind; // timesheet | time-card (doc-content)
}

const SUGGESTIONS = [
  'When was Hassan cancelled, and why?',
  "What's the amount paid as salary in October, and how much is pending?",
  'Which sites have their timesheets and time cards uploaded?',
  'Read this month\u2019s uploaded timesheet of any site and summarize it.',
  'Who supervises which branch, and what permissions do the admins have?',
  "What's the latest business news in the UAE?",
];

/** Parse a model reply that is a lookup directive; null when it is a normal
 *  answer. Tolerates minor surrounding whitespace only — the protocol asks
 *  for the directive alone. */
function parseLookupDirective(reply: string): LookupDirective | null {
  const text = reply.trim();
  // site names contain spaces — these forms need their own, looser value match
  const siteDocs = /^\[\[LOOKUP\]\]\s*site-docs\s*=\s*(.+?)\s*$/i.exec(text);
  if (siteDocs) return { kind: 'site-docs', siteName: siteDocs[1] };
  // doc-content=<site name>:<YYYY-MM>:<timesheet|time-card> — read INSIDE a file
  const docContent = /^\[\[LOOKUP\]\]\s*doc-content\s*=\s*(.+?)\s*$/i.exec(text);
  if (docContent) {
    const m = /^(.*):\s*(\d{4}-\d{2})\s*:\s*(timesheet|time-card)\s*$/i.exec(docContent[1].trim());
    if (!m) return null;
    return {
      kind: 'doc-content',
      siteName: m[1].trim(),
      month: m[2],
      docKind: m[3].toLowerCase() as SiteDocKind,
    };
  }
  const m = /^\[\[LOOKUP\]\]\s*(\w+)=([\w,\-]+)\s*$/i.exec(text);
  if (!m) return null;
  const [, kindRaw, value] = m;
  const kind = kindRaw.toLowerCase();
  if (kind === 'employees') {
    return { kind: 'employees', codes: value.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) };
  }
  if (kind === 'attendance' || kind === 'salary') {
    return /^\d{4}-\d{2}$/.test(value) ? { kind, month: value } : null;
  }
  return null;
}

/** The final answer must never leak a raw directive to the user. A reply made
 *  of directive lines only (hops exhausted) becomes a graceful fallback;
 *  otherwise stray directive tokens are stripped in place. */
function cleanFinalReply(reply: string): string {
  const lines = reply.split('\n').map((l) => l.trim()).filter(Boolean);
  const isDirectiveLine = (l: string): boolean => /^\[\[\s*(QUERY|LOOKUP|WEB)\b/i.test(l);
  if (lines.length > 0 && lines.every(isDirectiveLine)) return '';
  return reply.replace(/\[\[\s*(?:QUERY|LOOKUP|WEB)\s*:?[^\]]*\]\]/gi, '').trim();
}

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

// ---------------------------------------------------------------------------
// Block-level markdown — real GUI tables (with overflow + scrolling), lists,
// headings and paragraphs. The model is instructed (answer protocol #6) to
// answer multi-record questions with markdown pipe tables; this renderer
// turns them into styled <table> elements that scroll INSIDE the bubble:
//   • wide tables → horizontal scroll (overflow-x-auto, nowrap cells)
//   • long tables → vertical scroll (max-h + overflow-y-auto) with a sticky
//     header row so column titles stay visible
// ---------------------------------------------------------------------------

type MdBlock =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] };

const isUlItem = (t: string): boolean => /^[-*•]\s+/.test(t);
const isOlItem = (t: string): boolean => /^\d+[.)]\s+/.test(t);

/** "| a | b |" → ['a','b'] (leading/trailing pipes optional). */
const splitRow = (t: string): string[] =>
  t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** A table separator line: every cell is :--- / --- / ---: / :---:. */
const isTableSep = (t: string): boolean =>
  t.startsWith('|') && splitRow(t).length > 0 && splitRow(t).every((c) => /^:?-{3,}:?$/.test(c));

function parseBlocks(text: string): MdBlock[] {
  const lines = text.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }

    // markdown pipe table: header row + separator row + body rows
    if (t.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
      const head = splitRow(t);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        rows.push(splitRow(lines[j].trim()));
        j++;
      }
      blocks.push({ kind: 'table', head, rows });
      i = j;
      continue;
    }

    // heading
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) { blocks.push({ kind: 'h', text: h[2] }); i++; continue; }

    // unordered list
    if (isUlItem(t)) {
      const items: string[] = [];
      while (i < lines.length && isUlItem(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // ordered list
    if (isOlItem(t)) {
      const items: string[] = [];
      while (i < lines.length && isOlItem(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // paragraph — consecutive plain lines merged with spaces
    const plines: string[] = [];
    while (i < lines.length) {
      const lt = lines[i].trim();
      if (
        !lt || lt.startsWith('|') || /^#{1,4}\s/.test(lt)
        || isUlItem(lt) || isOlItem(lt)
      ) break;
      plines.push(lt);
      i++;
    }
    blocks.push({ kind: 'p', lines: plines });
  }
  return blocks;
}

/** One rendered markdown table — the scrollable GUI table for chat bubbles. */
function MarkdownTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div
      className={
        'my-1 max-h-72 overscroll-contain overflow-auto rounded-lg border border-border/70 bg-background/50 shadow-sm ' +
        // taller tables now that the panel itself is much taller
        'sm:max-h-[26rem] lg:max-h-[30rem] ' +
        // thin but VISIBLE scrollbar — signals that wide/long tables scroll
        '[scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 ' +
        '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border ' +
        '[&::-webkit-scrollbar-track]:bg-transparent'
      }
    >
      <table className="w-full border-separate border-spacing-0 text-[11.5px] leading-snug lg:text-xs">
        <thead>
          <tr>
            {head.map((h, j) => (
              <th
                key={j}
                scope="col"
                className="sticky top-0 z-10 whitespace-nowrap border-b border-border bg-muted px-2 py-1.5 text-left font-semibold text-foreground"
              >
                <InlineMarkdown text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, j) => (
            <tr key={j} className="odd:bg-muted/20">
              {row.map((cell, k) => (
                <td key={k} className="whitespace-nowrap border-b border-border/40 px-2 py-1.5 align-top">
                  <InlineMarkdown text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Assistant message body: blocks (tables / lists / headings / paragraphs)
 *  with inline **bold** + `code` spans everywhere. */
function MessageMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p key={i} className="pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <InlineMarkdown text={b.text} />
              </p>
            );
          case 'ul':
            return (
              <ul key={i} className="ml-4 list-disc space-y-0.5">
                {b.items.map((it, j) => (
                  <li key={j} className="leading-relaxed"><InlineMarkdown text={it} /></li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="ml-4 list-decimal space-y-0.5">
                {b.items.map((it, j) => (
                  <li key={j} className="leading-relaxed"><InlineMarkdown text={it} /></li>
                ))}
              </ol>
            );
          case 'table':
            return <MarkdownTable key={i} head={b.head} rows={b.rows} />;
          default:
            return (
              <p key={i} className="leading-relaxed">
                <InlineMarkdown text={b.lines.join(' ')} />
              </p>
            );
        }
      })}
    </div>
  );
}

export function AiChatWidget() {
  const user = useAuthStore((s) => s.user);
  const menuPermissions = useAuthStore((s) => s.menuPermissions);
  const settings = useSettingsStore((s) => s.settings);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const navigateTo = useAppStore((s) => s.navigateTo);

  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  /** "Searching the database…" — building the fresh knowledge base */
  const [preparing, setPreparing] = useState(false);
  /** "Digging deeper…" — running a [[LOOKUP]] round */
  const [digging, setDigging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** seconds the current question has been running — slow providers can now
   *  legally take up to ~90s per round, and a silent spinner feels broken */
  const [elapsedSec, setElapsedSec] = useState(0);
  /** one-line access description for the welcome card ("branches: Northern…") */
  const [accessLine, setAccessLine] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // live elapsed-seconds counter while a question is in flight
  useEffect(() => {
    if (!sending) return;
    const began = Date.now();
    setElapsedSec(0);
    const tick = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - began) / 1000));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [sending]);

  // keep the thread glued to the newest message
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, preparing, digging, sending, open]);

  // Escape collapses the panel
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // the welcome card shows this viewer's own access ("branches: Northern…")
  // — resolved once when the panel is first opened, refreshed on grants change
  useEffect(() => {
    if (!hasOpened || !user) return;
    let cancelled = false;
    resolveAiScope(user, menuPermissions)
      .then((scope) => { if (!cancelled) setAccessLine(describeScope(scope)); })
      .catch(() => { if (!cancelled) setAccessLine(null); });
    return () => { cancelled = true; };
  }, [hasOpened, user, menuPermissions]);

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
    if (sending || preparing || digging) return;
    setMessages([]);
    setError(null);
  };

  const autoSize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  };

  /** Fetch the data a [[LOOKUP]] directive asks for, formatted for the model —
   *  every path is limited to the viewer's access scope, so a branch admin's
   *  lookup can never pull another branch's records. */
  const runLookup = async (dir: LookupDirective, scope: AiScope): Promise<string> => {
    if (dir.kind === 'employees') {
      const wanted = new Set(dir.codes ?? []);
      const matched = [...scope.employees, ...scope.cancelledEmployees]
        .filter((e) => wanted.has(e.employee_code.toUpperCase()));
      if (matched.length === 0) {
        return `DATABASE LOOKUP RESULT — no employee matched those codes within your access (${describeScope(scope)}). If the code belongs to another branch, it is outside this viewer's scope; say so instead of guessing.`;
      }
      return `DATABASE LOOKUP RESULT — full records of ${matched.length} employee(s):\n${formatEmployeeDeepDive(matched)}`;
    }
    if (dir.kind === 'site-docs') {
      // a site's FULL uploaded-document history (every month since it started)
      // — only sites inside the viewer's scope are searched
      const needle = (dir.siteName ?? '').trim().toLowerCase();
      const site = scope.sites.find((s) => s.name.toLowerCase() === needle)
        ?? scope.sites.find((s) => s.name.toLowerCase().includes(needle));
      if (!site) {
        return `DATABASE LOOKUP ERROR — no site named "${dir.siteName}" exists within your access (${describeScope(scope)}). The snapshot's SITES section lists every site you can see; pick the exact name and re-run the [[LOOKUP]].`;
      }
      const months = monthsSince(site.created_at);
      const docs = await listSiteDocs(site.id, months).catch(() => []);
      return `DATABASE LOOKUP RESULT:\n${formatSiteDocuments(site.name, docs)}`;
    }
    if (dir.kind === 'doc-content') {
      // read the CONTENT of one uploaded file (timesheet XLSX/CSV or a PDF)
      // — the site must be inside the viewer's scope
      const needle = (dir.siteName ?? '').trim().toLowerCase();
      const site = scope.sites.find((s) => s.name.toLowerCase() === needle)
        ?? scope.sites.find((s) => s.name.toLowerCase().includes(needle));
      if (!site) {
        return `DATABASE LOOKUP ERROR — no site named "${dir.siteName}" exists within your access (${describeScope(scope)}). The snapshot's SITES section lists every site you can see; pick the exact name and re-run the [[LOOKUP]].`;
      }
      const months = monthsSince(site.created_at);
      const docs = await listSiteDocs(site.id, months).catch(() => []);
      const doc = docs.find((d) => d.month === dir.month && d.kind === dir.docKind);
      if (!doc) {
        const slots = docs.length > 0
          ? docs.map((d) => `${d.month}:${d.kind}`).join(', ')
          : 'no files uploaded at all';
        return `DATABASE LOOKUP ERROR — no ${dir.docKind} exists for "${site.name}" in ${dir.month}. Uploaded slots (month:kind): ${slots}. Re-run with one of those, or suggest uploading the file in Site Timesheets.`;
      }
      try {
        const content = await extractSiteDocText(doc);
        return `DATABASE LOOKUP RESULT:\n${formatSiteDocContent(site.name, doc, content)}`;
      } catch (err) {
        return `DATABASE LOOKUP ERROR — "${doc.name}" could not be read: ${(err as Error).message}. Tell the user the file exists but its content is not readable, and answer from the rest of the data if possible.`;
      }
    }
    const month = dir.month ?? '';
    if (dir.kind === 'attendance') {
      // attendance of the viewer's employees only (the scope's roster is
      // fresh — resolved moments ago for this very question)
      const records = await dataApi.getMonthAttendance(month);
      const scopedRecords = scope.unrestricted
        ? records
        : records.filter((r) => scope.employeeByIdInScope(r.employee_id));
      return `DATABASE LOOKUP RESULT:\n${formatAttendanceMonth(month, scopedRecords, [...scope.employees, ...scope.cancelledEmployees])}`;
    }
    // salary=YYYY-MM — narrowed inside the scope (totals recomputed)
    const year = Number(month.slice(0, 4));
    const mon = Number(month.slice(5, 7));
    const report = await dataApi.getSalarySheet(year, mon);
    return `DATABASE LOOKUP RESULT:\n${formatSalarySheetPeriod(year, mon, scope.scopeSalaryReport(report))}`;
  };

  /** Execute a [[QUERY]] directive (or feed its parse error back) — the
   *  engine drops every row outside the viewer's branch access. */
  const runQueryRound = async (
    parsed: { spec: AiQuerySpec } | { error: string },
    scope: AiScope,
  ): Promise<string> => {
    if ('spec' in parsed) return runAiQuery(parsed.spec, scope);
    return `DATABASE QUERY ERROR — ${parsed.error}`;
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || sending || preparing || digging) return;
    if (!hasKey) {
      setError('The AI connection has no API key yet — set it on the Site Settings page.');
      return;
    }
    setError(null);
    const bubble: ChatBubble = { role: 'user', content: text };
    setMessages((m) => [...m, bubble]);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';

    // fresh database read BEFORE every question — the snapshot is always
    // current AND limited to this viewer's access (a branch admin's Pebby
    // only ever sees their granted branches + directly assigned sites)
    setPreparing(true);
    setSending(true);
    let scope: AiScope | null = null;
    try {
      let system: string;
      try {
        scope = await resolveAiScope(user, menuPermissions);
        const kb = await buildAiKnowledgeBase(scope);
        system = buildAiSystemPrompt(kb, settings, scope);
        setAccessLine(describeScope(scope));
      } finally {
        setPreparing(false);
      }

      // the thread forwarded to the provider; [[LOOKUP]] rounds extend it
      // with hidden assistant directive + lookup-result exchanges
      let thread: ChatBubble[] = [...messages, bubble].slice(-MAX_HISTORY);
      let reply = '';

      for (let hop = 0; hop <= MAX_LOOKUP_HOPS; hop++) {
        const body: Record<string, unknown> = {
          action: 'chat',
          baseUrl: settings.ai_base_url,
          model: settings.ai_model,
          // demo mode: the raw key lives in the local demo store; in Supabase
          // mode no key is sent — the proxy reads the stored one server-side
          ...(isDemoMode ? { apiKey: demoDb.siteSettings.ai_api_key } : {}),
          messages: [{ role: 'system', content: system }, ...thread],
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
        // the platform (or a proxy) can answer a too-long request with an
        // HTML error page — parse defensively instead of throwing "Unexpected token <"
        let json: { ok?: boolean; reply?: string; error?: string } | null = null;
        try {
          json = (await res.json()) as { ok?: boolean; reply?: string; error?: string } | null;
        } catch {
          json = null;
        }
        if (!json) {
          throw new Error('The AI service returned an unreadable response — the host may have cut the request off. Please try again.');
        }
        if (!json.ok || typeof json.reply !== 'string') {
          throw new Error(json.error || 'The assistant could not answer that.');
        }
        reply = json.reply;

        // directives the model uses to pull more data before answering
        const queryParsed = parseAiQueryDirective(reply);
        const lookup = parseLookupDirective(reply);
        const needsRound = (queryParsed !== null || lookup !== null) && hop < MAX_LOOKUP_HOPS;
        if (!needsRound) break;

        // fetch the requested data (query result / lookup rows / parse
        // error) and ask again with it appended — every round is scoped to
        // the viewer's access, so directives can never pull other branches'
        // records
        setDigging(true);
        try {
          const context = queryParsed !== null
            ? await runQueryRound(queryParsed, scope as AiScope)
            : await runLookup(lookup as LookupDirective, scope as AiScope);
          const guidance = queryParsed !== null
            ? "system-provided query result — now answer the user's question with this data; if it is a QUERY ERROR, re-run a corrected [[QUERY]]; do not print any directive in the final answer"
            : "system-provided lookup result — now answer the user's question with this data; do not print any directive";
          thread = [
            ...thread,
            { role: 'assistant', content: reply },
            { role: 'user', content: `${context}\n\n( ${guidance} )` },
          ];
        } finally {
          setDigging(false);
        }
      }

      // the visible answer must never leak a raw directive
      const finalText = cleanFinalReply(reply) ||
        'I pulled the records but hit my data-retrieval limit for this question — please ask again or narrow it down (e.g. ask for a specific employee or month).';
      setMessages((m) => [...m, { role: 'assistant', content: finalText }]);
    } catch (e) {
      // roll the optimistic bubble back and hand the text back for editing
      setMessages((m) => (m[m.length - 1] === bubble ? m.slice(0, -1) : m));
      setInput(text);
      setError(e instanceof Error ? e.message : 'The chat request failed.');
    } finally {
      setPreparing(false);
      setDigging(false);
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
            aria-label="Pebby chat"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={
              'fixed z-50 flex flex-col overflow-hidden bg-card/70 shadow-2xl shadow-black/25 backdrop-blur-2xl backdrop-saturate-150 ' +
              // phones: a full-screen sheet — every pixel of the viewport is chat
              'inset-0 h-dvh w-full origin-bottom rounded-none border-0 ' +
              // sm and up: a floating panel anchored above the bubble button
              'sm:inset-auto sm:bottom-[5.75rem] sm:right-5 sm:origin-bottom-right ' +
              'sm:h-[min(40rem,78dvh)] sm:w-[min(28rem,calc(100vw-2.5rem))] sm:rounded-2xl sm:border sm:border-border/70 ' +
              // large screens: a properly roomy desktop chat window
              'lg:h-[min(46rem,84dvh)] lg:w-[min(38rem,calc(100vw-3rem))] xl:w-[min(42rem,calc(100vw-3rem))]'
            }
          >
            {/* header */}
            <div className="flex items-center gap-3 border-b border-border/70 bg-gradient-to-r from-brand/10 via-brand/5 to-transparent px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm sm:px-5 sm:pt-3">
              <div className="relative flex size-9 shrink-0 items-center justify-center rounded-xl brand-gradient text-brand-foreground">
                <PebbleAvatar className="size-6 drop-shadow-sm" />
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold leading-tight">{BOT_NAME}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {hasKey ? `Smart Assistant · ${settings.ai_model}` : 'Connection not configured'}
                </p>
              </div>
              <Button
                variant="ghost" size="icon" className="size-8 shrink-0" onClick={resetChat}
                disabled={messages.length === 0 || sending || preparing || digging} aria-label="Start a new chat"
                title="New chat"
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
            <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto bg-gradient-to-b from-brand/[0.06] to-brand/[0.02] px-4 py-4 sm:px-5 sm:py-5">
              {messages.length === 0 && !preparing ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl brand-gradient text-brand-foreground shadow-lg">
                    <PebbleAvatar className="size-9 drop-shadow-sm" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Hi, I&apos;m {BOT_NAME} — Smart Assistant</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      I search the {settings.project_name} database on every question — employees,
                      attendance, payroll, advances, cancellations, site documents
                      (timesheets &amp; time cards) and more — I can even read INSIDE the uploaded
                      timesheets and PDFs, and I can run complex queries. Multi-record
                      answers render as scrollable tables. For anything else, I research the web.
                    </p>
                    {/* this viewer's own access — Pebby answers inside it */}
                    {accessLine && (
                      <p className="mt-2 inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-[10.5px] leading-tight text-muted-foreground">
                        <span aria-hidden>🔒</span>
                        <span className="truncate">Your access: {accessLine}</span>
                      </p>
                    )}
                  </div>
                  <div className="mt-1 grid w-full grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s} type="button" onClick={() => void send(s)}
                        className="w-full rounded-lg border border-border bg-background/50 px-3.5 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
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
                        data-role={m.role}
                        className={cn(
                          'break-words rounded-2xl px-3.5 py-2 text-[13px] lg:text-sm',
                          m.role === 'user'
                            ? 'max-w-[85%] whitespace-pre-wrap leading-relaxed brand-gradient rounded-br-md text-brand-foreground shadow-sm'
                            // assistant bubbles render markdown BLOCKS — wide or
                            // long tables scroll inside the bubble, not the page
                            : 'max-w-[95%] rounded-bl-md border border-border/50 bg-card/80 text-foreground shadow-sm backdrop-blur-sm lg:max-w-[88%]',
                        )}
                      >
                        {m.role === 'user'
                          ? <InlineMarkdown text={m.content} />
                          : <MessageMarkdown text={m.content} />}
                      </div>
                    </div>
                  ))}
                  {(preparing || digging || sending) && (
                    <div className="flex justify-start">
                      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/50 bg-card/70 px-3.5 py-2 text-[13px] text-muted-foreground backdrop-blur-sm">
                        <Loader2 className="size-3.5 animate-spin" />
                        {preparing
                          ? 'Searching the database…'
                          : digging
                            ? 'Digging deeper into the records…'
                            : elapsedSec >= 30
                              ? 'Still thinking — the AI provider is slow, hang on…'
                              : 'Thinking…'}
                        {elapsedSec >= 10 && <span className="tabular-nums opacity-70">· {elapsedSec}s</span>}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* composer — or a friendly pointer when the key is missing */}
            {!hasKey ? (
              <div className="border-t border-border/70 bg-card/50 px-4 py-4 text-center backdrop-blur-sm">
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
              <div className="border-t border-border/70 bg-card/60 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:p-3">
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
                    className="min-h-11 flex-1 resize-none rounded-xl border border-border/70 bg-background/75 px-3.5 py-2.5 text-[13px] leading-snug outline-none placeholder:text-muted-foreground focus-visible:border-ring lg:text-sm"
                  />
                  <Button
                    type="submit" size="icon" aria-label="Send message"
                    className="size-10 shrink-0 rounded-xl brand-gradient text-brand-foreground"
                    disabled={!input.trim() || sending || preparing || digging}
                  >
                    {(sending || preparing || digging) ? <Loader2 className="size-4 animate-spin" /> : <SendHorizonal className="size-4" />}
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
        aria-label={open ? `Collapse ${BOT_NAME}` : `Open ${BOT_NAME} — Smart Assistant`}
        className={cn(
          'pebby-launcher fixed bottom-5 right-5 z-50 flex size-14 items-center justify-center rounded-full brand-gradient text-brand-foreground shadow-xl shadow-black/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          // phones: the chat is a full-screen sheet — the launcher would sit on
          // top of the composer, so it steps aside while the sheet is open
          open && 'max-sm:hidden',
        )}
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
            {open ? <X className="size-6" /> : <PebbleAvatar className="size-9 drop-shadow-md" />}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </>
  );
}
