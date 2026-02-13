import { useState, useRef, useCallback, useEffect } from "react";

// ─── Theme ───────────────────────────────────────────────────────────
const T = {
  bg: "#f8f8f7", surface: "#ffffff", surfaceAlt: "#f3f2f0",
  border: "#e5e2dd", borderLight: "#eeecea",
  text: "#2c2825", textSecondary: "#6b655c", textMuted: "#a9a49b", textFaint: "#d1cdc7",
  accent: "#2c2825",
  agentBg: "#fefdfb", agentBorder: "#ebe8e3",
  activeBg: "#fffbeb", activeBorder: "#fde68a", activeText: "#92400e",
  error: "#c53030", errorBg: "#fff5f5", errorBorder: "#fed7d7",
  success: "#2f855a", successBg: "#f0fdf4", successBorder: "#bbf7d0",
  link: "#1d4ed8",
};

const MONO = "'SF Mono','Fira Code','Cascadia Code','JetBrains Mono',monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif";
const SERIF = "'Georgia','Times New Roman',serif";

// ─── Export Formats ──────────────────────────────────────────────────
const EXPORT_FORMATS = [
  { id: "json", label: "JSON", ext: ".json", mime: "application/json" },
  { id: "csv", label: "CSV", ext: ".csv", mime: "text/csv" },
  { id: "markdown", label: "Markdown", ext: ".md", mime: "text/markdown" },
  { id: "txt", label: "Plain Text", ext: ".txt", mime: "text/plain" },
  { id: "sql", label: "SQL", ext: ".sql", mime: "text/plain" },
];

// ─── Utilities ───────────────────────────────────────────────────────
function downloadFile(content, filename, mime) {
  const b = new Blob([content], { type: mime });
  const u = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = u; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(u);
}

function escapeCSV(val) {
  const s = String(val ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function flattenForCSV(pages) {
  const rows = [];
  pages.forEach(p => {
    if (p.structured) {
      const walk = (obj, prefix = "") => {
        if (Array.isArray(obj)) {
          obj.forEach((item, i) => {
            if (typeof item === "object" && item) walk(item, `${prefix}[${i}]`);
            else rows.push({ source_url: p.url, key: `${prefix}[${i}]`, value: String(item) });
          });
        } else if (typeof obj === "object" && obj) {
          Object.entries(obj).forEach(([k, v]) => {
            if (typeof v === "object" && v) walk(v, prefix ? `${prefix}.${k}` : k);
            else rows.push({ source_url: p.url, key: prefix ? `${prefix}.${k}` : k, value: String(v) });
          });
        }
      };
      walk(p.structured);
    } else {
      rows.push({ source_url: p.url, key: "text", value: p.rawText?.substring(0, 500) || "" });
    }
  });
  return rows;
}

function generateExport(pages, summary, format, query) {
  const slug = query.replace(/[^a-z0-9]+/gi, "_").substring(0, 30);
  const fname = `research_${slug}_${Date.now()}${format.ext}`;
  let content;

  switch (format.id) {
    case "json":
      content = JSON.stringify({
        research_query: query,
        timestamp: new Date().toISOString(),
        summary,
        total_pages: pages.length,
        pages: pages.map(p => ({
          url: p.url,
          data: p.structured || { text: p.rawText },
        })),
      }, null, 2);
      break;
    case "csv": {
      const rows = flattenForCSV(pages);
      if (rows.length) {
        const cols = Object.keys(rows[0]);
        content = cols.map(escapeCSV).join(",") + "\n" + rows.map(r => cols.map(c => escapeCSV(r[c])).join(",")).join("\n");
      } else content = "No structured data";
      break;
    }
    case "markdown":
      content = `# Research: ${query}\n\n${summary}\n\n---\n\n` +
        pages.map(p => `## ${p.url}\n\n${p.rawText || "No content"}`).join("\n\n---\n\n");
      break;
    case "txt":
      content = `Research: ${query}\n${"=".repeat(40)}\n\n${summary}\n\n` +
        pages.map(p => `--- ${p.url} ---\n${p.rawText || "No content"}`).join("\n\n");
      break;
    case "sql": {
      const rows = flattenForCSV(pages);
      const ct = `CREATE TABLE IF NOT EXISTS research_data (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  source_url TEXT,\n  key TEXT,\n  value TEXT\n);\n\n`;
      const ins = rows.map(r => `INSERT INTO research_data (source_url, key, value) VALUES ('${r.source_url.replace(/'/g, "''")}', '${r.key.replace(/'/g, "''")}', '${r.value.replace(/'/g, "''").substring(0, 1000)}');`).join("\n");
      content = ct + ins;
      break;
    }
    default: content = JSON.stringify(pages, null, 2);
  }

  downloadFile(content, fname, format.mime);
}

// ─── API Engine ──────────────────────────────────────────────────────
async function callAPI(systemPrompt, userPrompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!r.ok) throw new Error(`API error ${r.status}: ${await r.text()}`);
  return r.json();
}

function parseResponse(data) {
  const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n\n") || "";
  let structured = null;
  try {
    const m = text.match(/```json\s*([\s\S]*?)```/);
    if (m) structured = JSON.parse(m[1].trim());
    else {
      const c = text.replace(/^[^{[]*/, "").replace(/[^}\]]*$/, "");
      if (c.startsWith("{") || c.startsWith("[")) structured = JSON.parse(c);
    }
  } catch {}
  return { rawText: text, structured, usage: data.usage };
}

// Phase 1: Plan the research
async function planResearch(userMessage, onStatus) {
  onStatus("Analyzing your request...");

  const sys = `You are a web research planning agent. The user will describe what data they want to find across the web. Your job is to create a research plan: determine what sites to search, what queries to use, and what data to extract.

IMPORTANT: Return a JSON plan. Think about:
- What specific forums, sites, or platforms are relevant (Reddit, Quora, specific niche forums, review sites, etc.)
- What search queries will find the best discussions/data
- What data points to extract from each source

Return ONLY a JSON block:
\`\`\`json
{
  "understanding": "Brief summary of what the user wants",
  "strategy": "Your approach to finding this data",
  "search_queries": [
    "specific search query 1",
    "specific search query 2",
    "specific search query 3"
  ],
  "target_sites": ["reddit.com", "quora.com", "other relevant sites"],
  "data_to_extract": ["key data points to look for"],
  "estimated_sources": 10
}
\`\`\`

Generate 4-8 diverse search queries that will find different angles of what the user wants. Include site-specific searches (e.g., "site:reddit.com sleeping issues remedies") and general searches.`;

  const result = await callAPI(sys, userMessage);
  const parsed = parseResponse(result);

  onStatus("Research plan ready.");
  return parsed;
}

// Phase 2: Discover URLs using search queries
async function discoverUrls(queries, targetSites, onStatus) {
  onStatus(`Searching across ${queries.length} queries...`);

  const sys = `You are a URL discovery engine. Use web search to find real, relevant URLs for the given search queries. For each query, find the most relevant discussion pages, forum threads, articles, and data sources.

CRITICAL RULES:
- Only return REAL URLs that actually exist
- Prioritize discussion threads, forum posts, and community content
- Include the page title and a brief relevance note
- Aim for diverse sources — don't return 10 links from the same thread

Return JSON:
\`\`\`json
{
  "discovered_urls": [
    { "url": "https://...", "title": "...", "source": "reddit|quora|forum|blog|other", "relevance": "why this is useful" }
  ]
}
\`\`\``;

  const queryList = queries.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const prompt = `Find URLs for these search queries:\n\n${queryList}\n\nTarget sites: ${targetSites.join(", ")}\n\nSearch each query and compile all unique, relevant URLs you find. Aim for 10-20 unique pages.`;

  const result = await callAPI(sys, prompt);
  const parsed = parseResponse(result);

  const urls = parsed.structured?.discovered_urls || [];
  onStatus(`Found ${urls.length} relevant pages.`);
  return urls;
}

// Phase 3: Scrape a single URL
async function scrapeUrl(url, dataPoints, onStatus) {
  onStatus(`Scraping: ${url}`);

  const sys = `You are a focused data extraction engine. Scrape the given URL and extract the specific data points requested. Focus on discussion content, user opinions, recommendations, complaints, and useful data.

Extract:
- Main topic/title of the page
- Key discussion points, opinions, and recommendations
- Specific data points requested by the researcher
- User sentiment (positive/negative/neutral)
- Any product mentions, brand mentions, or specific recommendations
- Upvote counts or engagement indicators if visible
- Date of the content if available

Return a JSON block:
\`\`\`json
{
  "page_title": "",
  "source_type": "reddit_thread|forum_post|article|review|other",
  "date": "",
  "main_topics": [],
  "key_findings": [
    { "finding": "...", "sentiment": "positive|negative|neutral", "engagement": "high|medium|low" }
  ],
  "recommendations_mentioned": [],
  "products_mentioned": [],
  "raw_discussions": [
    { "user": "", "text": "", "upvotes": 0 }
  ],
  "data_points": {}
}
\`\`\``;

  const prompt = `Scrape this URL: ${url}\n\nData points to extract: ${dataPoints.join(", ")}\n\nFetch this page using web search and extract all relevant discussion data, opinions, recommendations, and specific data points.`;

  const result = await callAPI(sys, prompt);
  return parseResponse(result);
}

// Phase 4: Synthesize all findings
async function synthesizeFindings(pages, originalQuery, onStatus) {
  onStatus("Synthesizing findings across all sources...");

  const pagesSummary = pages
    .filter(p => !p.error)
    .map((p, i) => `SOURCE ${i + 1} (${p.url}):\n${p.rawText?.substring(0, 800) || "No content"}`)
    .join("\n\n---\n\n");

  const sys = `You are a research synthesis engine. You've been given data scraped from multiple web sources. Create a comprehensive, actionable summary of all findings.

Structure your response as:
1. Executive summary (2-3 sentences)
2. Key themes found across sources
3. Most mentioned recommendations/products/solutions
4. Sentiment overview
5. Notable outliers or surprising findings
6. Actionable insights

Also return a JSON summary:
\`\`\`json
{
  "executive_summary": "",
  "total_sources_analyzed": 0,
  "key_themes": [{ "theme": "", "frequency": "high|medium|low", "sources_count": 0 }],
  "top_recommendations": [{ "item": "", "mentions": 0, "sentiment": "" }],
  "overall_sentiment": { "positive": 0, "negative": 0, "neutral": 0 },
  "actionable_insights": []
}
\`\`\``;

  const prompt = `Original research query: "${originalQuery}"\n\nHere is data from ${pages.length} sources:\n\n${pagesSummary}\n\nSynthesize all findings into a comprehensive research report.`;

  const result = await callAPI(sys, prompt);
  return parseResponse(result);
}

// ─── Full Research Pipeline ──────────────────────────────────────────
async function runResearch(userMessage, maxSources, onStatus, onPhase, onPageDone, abortRef) {
  // Phase 1: Plan
  onPhase("planning");
  const plan = await planResearch(userMessage, onStatus);
  if (abortRef.current) return null;

  const queries = plan.structured?.search_queries || ["web scraping " + userMessage];
  const targets = plan.structured?.target_sites || ["reddit.com", "quora.com"];
  const dataPoints = plan.structured?.data_to_extract || ["key findings"];

  onStatus(`Strategy: ${plan.structured?.strategy || "Searching the web..."}`);

  // Phase 2: Discover
  onPhase("discovering");
  const discoveredUrls = await discoverUrls(queries, targets, onStatus);
  if (abortRef.current) return null;

  const urlsToScrape = discoveredUrls.slice(0, maxSources);
  onStatus(`Will scrape ${urlsToScrape.length} of ${discoveredUrls.length} discovered pages (max: ${maxSources})`);

  // Phase 3: Scrape each
  onPhase("scraping");
  const pages = [];
  for (let i = 0; i < urlsToScrape.length; i++) {
    if (abortRef.current) { onStatus("Aborted."); break; }

    const urlObj = urlsToScrape[i];
    const url = typeof urlObj === "string" ? urlObj : urlObj.url;

    onStatus(`[${i + 1}/${urlsToScrape.length}] ${url}`);
    try {
      const scraped = await scrapeUrl(url, dataPoints, onStatus);
      const page = { url, ...scraped, error: false };
      pages.push(page);
      onPageDone(page, i + 1, urlsToScrape.length);
    } catch (err) {
      onStatus(`  ✗ Failed: ${err.message}`);
      pages.push({ url, rawText: `Error: ${err.message}`, structured: null, error: true });
      onPageDone({ url, error: true }, i + 1, urlsToScrape.length);
    }

    // Rate limit pause
    if (i < urlsToScrape.length - 1 && !abortRef.current) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  if (!pages.filter(p => !p.error).length) {
    return { pages, plan: plan.structured, synthesis: null, discoveredUrls };
  }

  // Phase 4: Synthesize
  onPhase("synthesizing");
  let synthesis = null;
  try {
    synthesis = await synthesizeFindings(pages, userMessage, onStatus);
  } catch (err) {
    onStatus(`Synthesis failed: ${err.message}`);
  }

  onPhase("done");
  onStatus(`✓ Research complete — ${pages.filter(p => !p.error).length} sources analyzed.`);

  return { pages, plan: plan.structured, synthesis, discoveredUrls };
}

// Also support direct URL scraping from chat
function isDirectUrl(msg) {
  return /^https?:\/\/\S+$/i.test(msg.trim()) || /^(www\.)\S+\.\S+$/i.test(msg.trim());
}

async function runDirectScrape(url, onStatus, onPhase) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  onPhase("scraping");
  onStatus(`Direct scrape: ${url}`);

  const sys = `You are an advanced web data extraction engine. Fetch the given URL and extract ALL data comprehensively. Return a readable summary AND a JSON block.

Extract: page title, all text content, links, images, tables, structured data, metadata.

\`\`\`json
{
  "metadata": { "title": "", "description": "", "language": "" },
  "text_content": { "headings": [], "body": "" },
  "links": { "internal": [], "external": [] },
  "images": [],
  "tables": [],
  "structured_data": {}
}
\`\`\``;

  const result = await callAPI(sys, `Extract all data from: ${url}`);
  const parsed = parseResponse(result);

  onPhase("done");
  onStatus("✓ Scrape complete.");

  return {
    pages: [{ url, ...parsed, error: false }],
    plan: null,
    synthesis: null,
    discoveredUrls: [],
  };
}

// ─── Components ──────────────────────────────────────────────────────
function PhaseIndicator({ phase }) {
  const phases = [
    { id: "planning", label: "Planning", icon: "◇" },
    { id: "discovering", label: "Discovering", icon: "◈" },
    { id: "scraping", label: "Scraping", icon: "◆" },
    { id: "synthesizing", label: "Synthesizing", icon: "◆" },
    { id: "done", label: "Done", icon: "✓" },
  ];

  const activeIdx = phases.findIndex(p => p.id === phase);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 16 }}>
      {phases.map((p, i) => {
        const isActive = p.id === phase;
        const isDone = i < activeIdx || phase === "done";
        return (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: "4px", fontSize: "11px",
              fontFamily: MONO, fontWeight: isActive ? 600 : 400,
              background: isDone ? T.successBg : isActive ? T.activeBg : "transparent",
              color: isDone ? T.success : isActive ? T.activeText : T.textFaint,
              border: `1px solid ${isDone ? T.successBorder : isActive ? T.activeBorder : "transparent"}`,
              transition: "all 0.3s ease",
            }}>
              {isDone ? "✓" : isActive ? <span style={{ animation: "spin 2s linear infinite", display: "inline-block" }}>⟳</span> : p.icon}
              <span>{p.label}</span>
            </div>
            {i < phases.length - 1 && <div style={{ width: 12, height: 1, background: T.textFaint }} />}
          </div>
        );
      })}
    </div>
  );
}

function ScrapeProgress({ current, total, pages }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: T.textSecondary, marginBottom: 4 }}>
        <span>{current}/{total} sources</span><span>{pct}%</span>
      </div>
      <div style={{ height: 3, background: T.surfaceAlt, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: T.activeText, borderRadius: 2, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function LogPanel({ logs }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs]);
  return (
    <div ref={ref} style={{
      fontFamily: MONO, fontSize: "11px", lineHeight: "1.7", padding: "10px 14px",
      background: T.surfaceAlt, borderRadius: "6px", border: `1px solid ${T.borderLight}`,
      maxHeight: "140px", overflowY: "auto", marginBottom: 12,
    }}>
      {logs.slice(-20).map((l, i) => (
        <div key={i} style={{ color: l.startsWith("[") ? T.activeText : l.startsWith("  ✗") ? T.error : l.startsWith("✓") ? T.success : T.textMuted }}>
          {l}
        </div>
      ))}
    </div>
  );
}

function ResearchResults({ data, query }) {
  const [view, setView] = useState("summary");
  const [activePage, setActivePage] = useState(0);
  const [expanded, setExpanded] = useState({});
  const [exporting, setExporting] = useState(null);

  const toggle = k => setExpanded(p => ({ ...p, [k]: !p[k] }));

  const renderData = (obj, depth = 0) => {
    if (obj == null) return <span style={{ color: T.textMuted }}>null</span>;
    if (typeof obj === "string") return <span style={{ color: T.textSecondary, wordBreak: "break-word" }}>{obj}</span>;
    if (typeof obj === "number") return <span style={{ color: "#b45309" }}>{obj}</span>;
    if (typeof obj === "boolean") return <span style={{ color: "#047857" }}>{String(obj)}</span>;
    if (Array.isArray(obj)) {
      if (!obj.length) return <span style={{ color: T.textMuted }}>[]</span>;
      if (obj.every(d => typeof d !== "object")) return (
        <div style={{ paddingLeft: depth > 0 ? 12 : 0 }}>{obj.map((it, i) => <div key={i} style={{ padding: "1px 0", fontSize: "12px", color: T.textSecondary }}><span style={{ color: T.textMuted }}>{i}.</span> {String(it)}</div>)}</div>
      );
      return (
        <div style={{ paddingLeft: depth > 0 ? 8 : 0 }}>
          {obj.slice(0, 40).map((it, i) => (
            <div key={i} style={{ margin: "3px 0", padding: "6px 10px", background: T.surfaceAlt, borderRadius: "5px", border: `1px solid ${T.borderLight}`, fontSize: "12px" }}>
              {renderData(it, depth + 1)}
            </div>
          ))}
          {obj.length > 40 && <div style={{ color: T.textMuted, fontSize: "11px" }}>...{obj.length - 40} more</div>}
        </div>
      );
    }
    if (typeof obj === "object") return (
      <div style={{ paddingLeft: depth > 0 ? 10 : 0 }}>
        {Object.entries(obj).map(([k, v]) => {
          const cx = typeof v === "object" && v !== null;
          const sk = `${depth}-${k}`;
          const open = expanded[sk] !== false;
          return (
            <div key={k} style={{ margin: "2px 0" }}>
              <div onClick={cx ? () => toggle(sk) : undefined} style={{ display: "flex", alignItems: "flex-start", gap: 6, cursor: cx ? "pointer" : "default", padding: "2px 0" }}>
                {cx && <span style={{ color: T.textMuted, fontSize: "9px", marginTop: 3 }}>{open ? "▼" : "▶"}</span>}
                <span style={{ color: T.textSecondary, fontSize: "11px", fontWeight: 600, fontFamily: MONO, minWidth: 70 }}>{k}</span>
                {!cx && <span style={{ color: T.text, fontSize: "12px", wordBreak: "break-all" }}>{String(v)}</span>}
                {cx && !open && <span style={{ color: T.textMuted, fontSize: "11px" }}>{Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`}</span>}
              </div>
              {cx && open && <div style={{ marginLeft: 6 }}>{renderData(v, depth + 1)}</div>}
            </div>
          );
        })}
      </div>
    );
    return <span>{String(obj)}</span>;
  };

  const views = [
    { id: "summary", label: "Summary" },
    { id: "sources", label: `Sources (${data.pages.length})` },
    { id: "structured", label: "Structured Data" },
    { id: "raw", label: "Raw JSON" },
  ];

  const handleExport = (fmt) => {
    setExporting(fmt.id);
    generateExport(data.pages, data.synthesis?.rawText || "", fmt, query);
    setTimeout(() => setExporting(null), 800);
  };

  return (
    <div style={{ background: T.surface, borderRadius: "10px", border: `1px solid ${T.border}`, overflow: "hidden" }}>
      {/* Export bar */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.borderLight}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "11px", color: T.textMuted, fontFamily: MONO, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", marginRight: 4 }}>Export</span>
        {EXPORT_FORMATS.map(fmt => (
          <button key={fmt.id} onClick={() => handleExport(fmt)} style={{
            padding: "4px 10px", fontSize: "11px", fontFamily: MONO,
            background: exporting === fmt.id ? T.successBg : "transparent",
            border: `1px solid ${exporting === fmt.id ? T.successBorder : T.border}`,
            borderRadius: "4px", cursor: "pointer",
            color: exporting === fmt.id ? T.success : T.textSecondary,
            transition: "all 0.15s",
          }}>
            {exporting === fmt.id ? "✓" : "↓"} {fmt.label}
          </button>
        ))}
      </div>

      {/* View tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${T.borderLight}` }}>
        {views.map(v => (
          <button key={v.id} onClick={() => setView(v.id)} style={{
            padding: "8px 14px", fontSize: "12px", fontWeight: 500, fontFamily: MONO,
            background: "none", border: "none", cursor: "pointer",
            color: view === v.id ? T.text : T.textMuted,
            borderBottom: view === v.id ? `2px solid ${T.accent}` : "2px solid transparent",
            transition: "all 0.15s",
          }}>
            {v.label}
          </button>
        ))}
      </div>

      <div style={{ padding: "16px", minHeight: 200, maxHeight: 600, overflowY: "auto" }}>
        {view === "summary" && (
          <div>
            {data.synthesis ? (
              <div style={{ fontSize: "14px", lineHeight: "1.8", color: T.textSecondary, fontFamily: SERIF, whiteSpace: "pre-wrap" }}>
                {data.synthesis.rawText}
              </div>
            ) : (
              <div style={{ color: T.textMuted, textAlign: "center", padding: 20 }}>
                No synthesis available — check individual sources.
              </div>
            )}
          </div>
        )}

        {view === "sources" && (
          <div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12 }}>
              {data.pages.map((p, i) => {
                let host = ""; try { host = new URL(p.url).hostname; } catch {}
                return (
                  <button key={i} onClick={() => setActivePage(i)} style={{
                    padding: "4px 10px", fontSize: "11px", fontFamily: MONO, borderRadius: "4px", cursor: "pointer",
                    background: activePage === i ? T.accent : p.error ? T.errorBg : "transparent",
                    color: activePage === i ? "#fff" : p.error ? T.error : T.textSecondary,
                    border: `1px solid ${activePage === i ? T.accent : p.error ? T.errorBorder : T.border}`,
                    maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {p.error ? "✗ " : ""}{host}
                  </button>
                );
              })}
            </div>
            {data.pages[activePage] && (
              <div>
                <div style={{ fontSize: "11px", color: T.link, marginBottom: 8, wordBreak: "break-all" }}>{data.pages[activePage].url}</div>
                <div style={{ fontSize: "13px", lineHeight: "1.7", color: T.textSecondary, fontFamily: SERIF, whiteSpace: "pre-wrap" }}>
                  {data.pages[activePage].rawText || "No content"}
                </div>
              </div>
            )}
          </div>
        )}

        {view === "structured" && (
          <div>
            {data.synthesis?.structured && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: "11px", fontFamily: MONO, fontWeight: 600, color: T.textMuted, letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: 8 }}>Synthesis</div>
                {renderData(data.synthesis.structured)}
              </div>
            )}
            {data.pages.filter(p => p.structured).map((p, i) => (
              <div key={i} style={{ marginBottom: 12, padding: "12px", background: T.surfaceAlt, borderRadius: "6px", border: `1px solid ${T.borderLight}` }}>
                <div style={{ fontSize: "11px", color: T.link, marginBottom: 6 }}>{p.url}</div>
                {renderData(p.structured)}
              </div>
            ))}
            {!data.pages.some(p => p.structured) && !data.synthesis?.structured && (
              <div style={{ color: T.textMuted, textAlign: "center", padding: 20 }}>No structured data.</div>
            )}
          </div>
        )}

        {view === "raw" && (
          <pre style={{
            fontFamily: MONO, fontSize: "11px", lineHeight: "1.5", color: T.textSecondary,
            background: T.surfaceAlt, padding: "14px", borderRadius: "6px",
            border: `1px solid ${T.borderLight}`, whiteSpace: "pre-wrap", maxHeight: 500, overflowY: "auto",
          }}>
            {JSON.stringify({
              query, plan: data.plan,
              synthesis: data.synthesis?.structured,
              pages: data.pages.map(p => ({ url: p.url, data: p.structured })),
            }, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Chat Message Component ──────────────────────────────────────────
function ChatMessage({ msg }) {
  if (msg.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <div style={{
          maxWidth: "75%", padding: "10px 14px", borderRadius: "12px 12px 2px 12px",
          background: T.accent, color: "#fff", fontSize: "14px", lineHeight: "1.6", fontFamily: SANS,
        }}>
          {msg.content}
        </div>
      </div>
    );
  }

  // Agent message
  return (
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 16 }}>
      <div style={{ maxWidth: "90%", width: "100%" }}>
        {/* Agent label */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: msg.loading ? T.activeText : T.success }} />
          <span style={{ fontSize: "11px", fontFamily: MONO, fontWeight: 600, color: T.textMuted, letterSpacing: "0.5px", textTransform: "uppercase" }}>
            {msg.loading ? "Researching..." : "Agent"}
          </span>
        </div>

        <div style={{
          padding: "14px 16px", borderRadius: "2px 12px 12px 12px",
          background: T.agentBg, border: `1px solid ${T.agentBorder}`,
        }}>
          {/* Phase indicator */}
          {msg.phase && msg.phase !== "done" && <PhaseIndicator phase={msg.phase} />}

          {/* Scrape progress */}
          {msg.scrapeProgress && msg.scrapeProgress.total > 1 && (
            <ScrapeProgress current={msg.scrapeProgress.current} total={msg.scrapeProgress.total} pages={msg.scrapeProgress.pages} />
          )}

          {/* Status log */}
          {msg.logs && msg.logs.length > 0 && msg.loading && <LogPanel logs={msg.logs} />}

          {/* Text content */}
          {msg.text && (
            <div style={{ fontSize: "14px", lineHeight: "1.7", color: T.textSecondary, fontFamily: SANS, whiteSpace: "pre-wrap" }}>
              {msg.text}
            </div>
          )}

          {/* Research results */}
          {msg.results && <ResearchResults data={msg.results} query={msg.query || ""} />}
        </div>
      </div>
    </div>
  );
}

// ─── Suggestions ─────────────────────────────────────────────────────
const SUGGESTIONS = [
  "Find Reddit discussions about common sleeping issues and what remedies people recommend",
  "Scrape health forums for discussions about hair loss treatments and what actually works",
  "Research trending dropshipping products people are talking about on forums",
  "Find discussions about the best budget mechanical keyboards across Reddit and forums",
  "https://news.ycombinator.com",
];

// ─── Main App ────────────────────────────────────────────────────────
export default function WebScraper() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [maxSources, setMaxSources] = useState(8);
  const [showSettings, setShowSettings] = useState(false);
  const abortRef = useRef(false);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const updateLastAgent = useCallback((updates) => {
    setMessages(prev => {
      const msgs = [...prev];
      const lastAgent = msgs.findLastIndex(m => m.role === "agent");
      if (lastAgent >= 0) msgs[lastAgent] = { ...msgs[lastAgent], ...updates };
      return msgs;
    });
  }, []);

  const handleSend = async () => {
    const msg = input.trim();
    if (!msg || isLoading) return;

    setInput("");
    setIsLoading(true);
    abortRef.current = false;

    // Add user message
    setMessages(prev => [...prev, { role: "user", content: msg }]);

    // Add loading agent message
    const agentMsg = { role: "agent", text: "", loading: true, phase: null, logs: [], scrapeProgress: null, results: null, query: msg };
    setMessages(prev => [...prev, agentMsg]);

    try {
      let result;

      if (isDirectUrl(msg)) {
        // Direct URL scrape
        result = await runDirectScrape(
          msg,
          (status) => updateLastAgent({ logs: prev => { const l = [...(Array.isArray(prev?.logs) ? prev.logs : []), status]; return { logs: l }; } }),
          (phase) => updateLastAgent({ phase }),
        );

        // Simplified status updates for direct scrape
        const statusLogs = [];
        const logFn = (s) => { statusLogs.push(s); updateLastAgent({ logs: statusLogs }); };
        const phaseFn = (p) => updateLastAgent({ phase: p });

        result = await runDirectScrape(msg, logFn, phaseFn);
      } else {
        // AI research pipeline
        const statusLogs = [];
        const logFn = (s) => { statusLogs.push(s); updateLastAgent({ logs: statusLogs }); };
        const phaseFn = (p) => updateLastAgent({ phase: p });
        const pageFn = (page, current, total) => {
          updateLastAgent({ scrapeProgress: { current, total, pages: [] } });
        };

        result = await runResearch(msg, maxSources, logFn, phaseFn, pageFn, abortRef);
      }

      if (result) {
        const successCount = result.pages.filter(p => !p.error).length;
        const summaryText = isDirectUrl(msg)
          ? `Scraped successfully. ${result.pages[0]?.structured ? "Structured data extracted." : "Text content extracted."}`
          : `Research complete. Analyzed ${successCount} source${successCount !== 1 ? "s" : ""} across the web.`;

        updateLastAgent({
          text: summaryText,
          loading: false,
          phase: "done",
          results: result,
          query: msg,
        });
      }
    } catch (err) {
      updateLastAgent({
        text: `Something went wrong: ${err.message}\n\nTry rephrasing your request or pasting a direct URL.`,
        loading: false,
        phase: null,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAbort = () => { abortRef.current = true; };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: T.bg, fontFamily: SANS }}>
      <style>{`
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        ::selection{background:#2c282518}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${T.textFaint};border-radius:3px}
        input::placeholder{color:${T.textFaint}}
        textarea::placeholder{color:${T.textFaint}}
        textarea{resize:none}
        input[type=range]{-webkit-appearance:none;height:4px;background:${T.border};border-radius:2px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;background:${T.accent};border-radius:50%;cursor:pointer}
      `}</style>

      {/* Header */}
      <div style={{
        padding: "12px 24px", borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: T.surface,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: isLoading ? T.activeText : T.textFaint,
            boxShadow: isLoading ? `0 0 8px ${T.activeText}40` : "none",
          }} />
          <span style={{ fontSize: "13px", fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", fontFamily: MONO, color: T.text }}>
            WebScrape
          </span>
          <span style={{ fontSize: "10px", color: T.textMuted, fontFamily: MONO }}>v3 — AI Research Agent</span>
        </div>
        <button onClick={() => setShowSettings(!showSettings)} style={{
          padding: "4px 12px", fontSize: "11px", fontFamily: MONO,
          background: showSettings ? T.surfaceAlt : "transparent",
          border: `1px solid ${showSettings ? T.border : "transparent"}`,
          borderRadius: "4px", cursor: "pointer", color: T.textMuted,
        }}>
          ⚙ Sources: {maxSources}
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{ padding: "12px 24px", background: T.surface, borderBottom: `1px solid ${T.border}`, animation: "fadeIn 0.15s ease" }}>
          <div style={{ maxWidth: 400 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: "12px", color: T.textSecondary }}>Max sources per research</span>
              <span style={{ fontSize: "14px", fontWeight: 600, fontFamily: MONO, color: T.text }}>{maxSources}</span>
            </div>
            <input type="range" min={3} max={30} value={maxSources} onChange={e => setMaxSources(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: T.textFaint, marginTop: 2 }}>
              <span>3 (quick)</span><span>30 (thorough)</span>
            </div>
          </div>
        </div>
      )}

      {/* Chat area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 100px" }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          {/* Welcome state */}
          {messages.length === 0 && (
            <div style={{ textAlign: "center", paddingTop: 60 }}>
              <div style={{ fontSize: "28px", fontWeight: 700, color: T.text, marginBottom: 8, fontFamily: SANS }}>
                What do you want to research?
              </div>
              <p style={{ fontSize: "14px", color: T.textMuted, maxWidth: 500, margin: "0 auto 32px", lineHeight: 1.6 }}>
                Tell me what data you need and I'll search the web, scrape relevant sources, and synthesize the findings. Or paste a URL to scrape directly.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 560, margin: "0 auto" }}>
                {SUGGESTIONS.map((s, i) => (
                  <button key={i} onClick={() => { setInput(s); inputRef.current?.focus(); }}
                    style={{
                      padding: "10px 16px", textAlign: "left", fontSize: "13px", color: T.textSecondary,
                      background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px",
                      cursor: "pointer", fontFamily: SANS, lineHeight: 1.5, transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = T.textMuted; e.currentTarget.style.background = T.agentBg; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.surface; }}
                  >
                    {s.startsWith("http") ? `🔗 ${s}` : `→ ${s}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          {messages.map((msg, i) => <ChatMessage key={i} msg={msg} />)}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Input bar */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        background: `linear-gradient(transparent, ${T.bg} 20%)`,
        padding: "20px 24px 20px",
      }}>
        <div style={{
          maxWidth: 800, margin: "0 auto",
          display: "flex", gap: 8, alignItems: "flex-end",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px",
          padding: "8px 8px 8px 16px", boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={isLoading ? "Researching..." : "Describe what you want to research, or paste a URL..."}
            disabled={isLoading}
            rows={1}
            style={{
              flex: 1, padding: "8px 0", fontSize: "14px", fontFamily: SANS,
              background: "transparent", border: "none", outline: "none",
              color: T.text, lineHeight: "1.5", minHeight: 24, maxHeight: 120,
              overflow: "auto",
            }}
            onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
          />
          {isLoading ? (
            <button onClick={handleAbort} style={{
              padding: "8px 16px", fontSize: "12px", fontWeight: 600, fontFamily: MONO,
              background: T.error, color: "#fff", border: "none", borderRadius: "8px",
              cursor: "pointer", flexShrink: 0,
            }}>
              Stop
            </button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()} style={{
              padding: "8px 16px", fontSize: "12px", fontWeight: 600, fontFamily: MONO,
              background: input.trim() ? T.accent : T.surfaceAlt,
              color: input.trim() ? "#fff" : T.textFaint,
              border: "none", borderRadius: "8px", cursor: input.trim() ? "pointer" : "default",
              flexShrink: 0, transition: "all 0.15s",
            }}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
