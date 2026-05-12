#!/usr/bin/env node
/**
 * AgentMinds MCP Server
 *
 * Gives Claude Code, Cursor, Zed, Replit, and any other MCP-aware
 * client native access to AgentMinds Central. Instead of writing
 * curl commands, the client calls tools directly:
 *   - agentminds_connect: Pull data + get recommendations
 *   - agentminds_actions: Get action plan
 *   - agentminds_agent_detail: Get specific agent info
 *   - agentminds_status: System health check
 *   - agentminds_push: Push local analysis to Central
 *
 * Standards alignment (per AgentMinds Reporting Profile v1.0):
 *   - Tool calls return ARP-conformant payloads — see §3 of the spec
 *     at https://github.com/agentmindsdev/profile
 *   - `agentminds_push` accepts the ARP envelope shape; server-side
 *     fingerprint enrichment happens on ingest
 *   - Companion HTTP discovery: GET /.well-known/agent-card.json
 *     (A2A AgentCard, action #1 in the standards engagement plan)
 *   - Companion OTel ingest: POST /sync/ingest/otel for callers
 *     instrumenting via OpenTelemetry GenAI semconv
 *
 * Setup in Claude Code:
 *   claude mcp add agentminds -- node /path/to/server.js
 *
 * Environment:
 *   AGENTMINDS_API_KEY=sk_...
 *   AGENTMINDS_API_URL=https://api.agentminds.dev (default)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import https from "https";

// Try to read key from project's .env or .agentminds.json
import fs from "fs";
import path from "path";

function loadProjectKey() {
  const cwd = process.cwd();

  // 1. From .agentminds.json
  try {
    const configPath = path.join(cwd, ".agentminds.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.api_key) return config.api_key;
    }
  } catch {}

  // 2. From .env file
  try {
    const envPath = path.join(cwd, ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(/AGENTMINDS_API_KEY=(.+)/);
      if (match) return match[1].trim();
    }
  } catch {}

  return "";
}

const API_URL = process.env.AGENTMINDS_API_URL || "https://api.agentminds.dev";
let API_KEY = process.env.AGENTMINDS_API_KEY || loadProjectKey();

// ══════════════════════════════════════════════════════════════
// Auto-register: detect project info and register if no key
// ══════════════════════════════════════════════════════════════

function detectProjectInfo() {
  const cwd = process.cwd();
  let name = path.basename(cwd);
  let url = "";

  // Try package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
    if (pkg.name) name = pkg.name;
    if (pkg.homepage) url = pkg.homepage;
  } catch {}

  // Try .env for SITE_URL or similar
  try {
    const env = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
    const urlMatch = env.match(/(?:SITE_URL|FRONTEND_URL|NEXT_PUBLIC_URL|BASE_URL|VITE_APP_URL)\s*=\s*(.+)/i);
    if (urlMatch) url = urlMatch[1].trim().replace(/["']/g, "");
    const nameMatch = env.match(/(?:SITE_NAME|APP_NAME)\s*=\s*(.+)/i);
    if (nameMatch) name = nameMatch[1].trim().replace(/["']/g, "");
  } catch {}

  // Try site_config.json
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, "site_config.json"), "utf-8"));
    if (cfg.site_url) url = cfg.site_url;
    if (cfg.site_name) name = cfg.site_name;
  } catch {}

  return { name, url };
}

function saveKey(siteId, apiKey, siteUrl, siteName) {
  const cwd = process.cwd();
  const configPath = path.join(cwd, ".agentminds.json");

  try {
    const existing = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
      : {};
    existing.site_id = siteId;
    existing.api_key = apiKey;
    existing.site_url = siteUrl;
    existing.site_name = siteName;
    existing.registered_at = new Date().toISOString();
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
    // v1.3.3: harden file permissions so the API key is not
    // world-readable on POSIX systems. Windows ignores chmod.
    // Non-fatal — log + continue if it fails (older Node, weird FS).
    if (process.platform !== "win32") {
      try { fs.chmodSync(configPath, 0o600); }
      catch { /* best effort; do not block onboarding */ }
    }
    return true;
  } catch {
    // Fallback: try .env
    try {
      const envPath = path.join(cwd, ".env");
      const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
      if (!content.includes("AGENTMINDS_API_KEY")) {
        fs.appendFileSync(envPath, `\nAGENTMINDS_API_KEY=${apiKey}\nAGENTMINDS_SITE_ID=${siteId}\n`);
      }
      return true;
    } catch { return false; }
  }
}

async function autoRegisterIfNeeded() {
  if (API_KEY) return { registered: false, reason: "already_has_key" };

  const info = detectProjectInfo();

  // Local project (no URL or localhost) — register by project name
  const isLocal = !info.url || info.url.includes("localhost") || info.url.includes("127.0.0.1");
  const regUrl = isLocal ? "local" : info.url;
  const regName = info.name || path.basename(process.cwd());

  if (isLocal && !regName) {
    return { registered: false, reason: "no_url_detected", name: info.name };
  }

  try {
    const data = await httpPost("/api/v1/sync/onboard", { url: regUrl, name: regName });
    if (data.api_key && data.site_id) {
      API_KEY = data.api_key;
      saveKey(data.site_id, data.api_key, info.url, info.name);
      return {
        registered: true,
        site_id: data.site_id,
        api_key: data.api_key,
        site_type: data.site_type,
        agents: data.enabled_agents,
      };
    }
    // Already registered — need manual key entry
    if (data.detail && data.detail.includes("already registered")) {
      return { registered: false, reason: "already_registered_need_key", detail: data.detail };
    }
    return { registered: false, reason: "onboard_failed", detail: JSON.stringify(data).substring(0, 200) };
  } catch (e) {
    return { registered: false, reason: "connection_error", detail: e.message };
  }
}

// ══════════════════════════════════════════════════════════════
// Rate limiting — gift-economy mode (v1.4.0, 2026-05-12).
// AgentMinds is free for everyone. The previous 1-request/day
// trial cap was a paid-tier funnel; with no tiers there's no
// reason to throttle. Functions kept (still called from the
// dispatcher) but always allow + report "unlimited".
// ══════════════════════════════════════════════════════════════

const FREE_DAILY_LIMIT = Number.POSITIVE_INFINITY;
const rateLimitFile = path.join(process.cwd(), ".agentminds_usage.json");

function getRateLimit() {
  try {
    if (fs.existsSync(rateLimitFile)) {
      const data = JSON.parse(fs.readFileSync(rateLimitFile, "utf-8"));
      const today = new Date().toISOString().split("T")[0];
      if (data.date === today) return data;
    }
  } catch {}
  return { date: new Date().toISOString().split("T")[0], count: 0 };
}

function incrementRateLimit() {
  const data = getRateLimit();
  data.count++;
  try { fs.writeFileSync(rateLimitFile, JSON.stringify(data)); } catch {}
  return data;
}

function checkRateLimit() {
  // Always allow. Counter stays for local-usage curiosity but
  // never blocks. Keeping the function so the dispatcher does
  // not need to change shape.
  return { allowed: true, remaining: "unlimited" };
}

// ══════════════════════════════════════════════════════════════
// HTTP helpers
// ══════════════════════════════════════════════════════════════

// User-Agent identifies MCP traffic in Render server access logs so we
// can measure "downloads → real API calls → registers" funnel without
// adding a separate telemetry endpoint.
const MCP_UA = "agentminds-mcp/1.4.0";

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL + path);
    const headers = { "Accept": "application/json", "User-Agent": MCP_UA };
    if (API_KEY) headers["X-AgentMinds-Key"] = API_KEY;

    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method: "GET", headers, timeout: 60000,
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(API_URL + path);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "User-Agent": MCP_UA,
    };
    if (API_KEY) headers["X-AgentMinds-Key"] = API_KEY;

    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname,
      method: "POST", headers, timeout: 60000,
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(payload);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════
// Format helpers
// ══════════════════════════════════════════════════════════════

// Universal feedback prompt appended to every "success" tool output.
// The single most useful signal for the project — calls to action
// asking the user (or the AI parsing the result) to submit a verdict.
// Defined once here so the wording stays consistent everywhere.
const FEEDBACK_FOOTER = [
  "",
  "---",
  "💬 **Was this useful?** Call `agentminds_feedback` with",
  "`usefulness: yes | no | sort_of` (optional `note`). All three",
  "verdicts help equally — this is the only direct measure of",
  "whether AgentMinds is solving a real problem.",
].join("\n");

function appendFeedback(lines) {
  lines.push(FEEDBACK_FOOTER);
  return lines;
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

function formatActions(data) {
  const lines = [];
  lines.push(`# AgentMinds — ${data.site_id || "Unknown"}`);
  lines.push(`Score: ${data.summary || "N/A"}`);
  lines.push(`Total actions: ${data.total_actions || 0}`);
  lines.push("");

  if (data.actions?.critical?.length) {
    lines.push(`## CRITICAL (${data.actions.critical.length})`);
    for (const c of data.actions.critical) {
      lines.push(`- [${c.agent}] ${c.action}`);
    }
    lines.push("");
  }

  if (data.actions?.warning?.length) {
    lines.push(`## WARNINGS (${data.actions.warning.length})`);
    for (const w of data.actions.warning) {
      lines.push(`- [${w.agent}] ${w.action}`);
    }
    lines.push("");
  }

  if (data.actions?.recommendations?.length) {
    lines.push(`## RECOMMENDATIONS (${data.actions.recommendations.length})`);
    for (const r of data.actions.recommendations) {
      lines.push(`- [${r.priority || "?"}] [${r.agent}] ${r.action}`);
    }
    lines.push("");
  }

  if (data.cross_site_tips?.length) {
    lines.push(`## CROSS-SITE TIPS (${data.cross_site_tips.length})`);
    for (const t of data.cross_site_tips) {
      lines.push(`- [${t.agent}] ${t.tip}`);
      lines.push(`  How: ${t.how}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════
// MCP Server
// ══════════════════════════════════════════════════════════════

const server = new Server(
  { name: "agentminds", version: "1.4.0" },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "agentminds_intro",
      description: `Introduction to AgentMinds — call this FIRST if you're new to the server.

Returns:
- What AgentMinds is + the cross-site moat (~400+ patterns from peer sites)
- Live network stats (sites, patterns, uptime)
- Recommended first-call sequence (status → register → push → connect)
- Trust signals (open spec, license, MCP engagement)

Zero arguments required. No auth needed. Pure discovery + onboarding.

When to call: first interaction, new agent session, when context is unclear.`,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "agentminds_connect",
      description: `Get AI agent improvement recommendations from the AgentMinds network.

WORKS WITHOUT REGISTRATION. Gift-economy mode (v1.4.0):
AgentMinds is free for everyone. No daily caps, no tiers, no
push-to-unlock gates. Two access shapes:

1. ANONYMOUS (no API key in env):
   Returns top production-observed patterns from the network.
   Default 100 patterns; pass limit=all for the entire public
   projection of the pool.

2. REGISTERED (API key set):
   Returns stack-matched personalised recommendations including
   cross-site references, negative evidence, reversibility labels.
   Full ARP v1.3 response shape. Push agent reports voluntarily
   to grow the pool — pushing is optional and never required.

CRITICAL ANTI-HALLUCINATION RULES (preserved from v1.2.x):
1. NEVER fabricate recommendations.
2. ALWAYS use the tool's actual response — do not invent patterns.
3. If the API is unreachable, output "API unreachable" — do not improvise.
4. Both modes return REAL data from the pool — show it as-is.
5. Distinguish in your output:
   - trial_anonymous mode = "popular in the network"
   - personalised mode    = "matched to your stack"`,
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max patterns to return (default 30, capped at 100 client-side).",
          },
          site_url: {
            type: "string",
            description: "Site URL hint for registration (legacy — auth-aware paths read AGENTMINDS_API_KEY from env).",
          },
          brain_export_url: {
            type: "string",
            description: "URL to pull brain data from (legacy — prefer agentminds_push for direct submission).",
          },
        },
      },
    },
    {
      name: "agentminds_push",
      description: `Push your agent reports to the AgentMinds network.

Pushing is voluntary and never required to keep pulling patterns
— it's how the pool grows for everyone, including you. After at
least one push, agentminds_connect personalised recommendations
include cross-site references (where peer sites with overlapping
stacks have observed the same pattern).

Required minimum: at least one report with agent + severity + summary.
The more signal you include (metrics, warnings, learned_patterns), the higher
your data_quality grade and the better personalised matching gets.

Envelope (one item in reports[]):

{
  "agent":     "auth_service",                       // string, your agent's name
  "report": {
    "severity": "warning",                           // "info" | "warning" | "error" | "critical"
    "summary":  "JWT validation failing intermittently under load",
    "metrics":  { "requests": 12450, "errors": 23, "avg_latency_ms": 145 },
    "warnings": [
      { "severity": "warning", "message": "JWT signature mismatch on 0.2% of requests" }
    ],
    "recommendations": [
      { "title": "Add retry logic", "priority": "high" }
    ]
  },
  "memory": {
    "learned_patterns": [
      {
        "pattern":    "JWT clock skew tolerance must be >30s",
        "category":   "auth",
        "confidence": 0.9,
        "status":     "active",
        "impact":     "high"
      }
    ]
  }
}

Server returns a data_quality block per push: grade (A-F),
average_score, accepted_reports/total_reports, and any flagged
issues. Grade < D suppresses the report from cross-site delivery.

Anti-hallucination contract: if the server rejects the payload, the
tool surfaces the actual response (HTTP status + raw JSON). It will
NEVER claim success without backend confirmation.`,
      inputSchema: {
        type: "object",
        properties: {
          reports: {
            type: "array",
            description: "Array of DETAILED agent reports. Each must have: agent, report (severity, summary, metrics, warnings, recommendations), memory (learned_patterns)",
          },
          brain_export_url: {
            type: "string",
            description: "URL for Central to pull brain data from (alternative to sending reports directly)",
          },
        },
      },
    },
    {
      name: "agentminds_actions",
      description: "Get action plan — ONLY works if you already pushed data. If no data was pushed, this returns nothing. DO NOT fabricate recommendations. Show only what this tool returns.",
      inputSchema: {
        type: "object",
        properties: {
          site_id: {
            type: "string",
            description: "Site ID (e.g. mimari_ai, gridera_io). If not provided, determined from API key.",
          },
        },
      },
    },
    {
      name: "agentminds_agent_detail",
      description: "Get detailed info about a specific agent — metrics, warnings, patterns, recommendations. Use when user asks about a specific agent like 'health agent ne diyor?', 'security durumu'.",
      inputSchema: {
        type: "object",
        properties: {
          site_id: {
            type: "string",
            description: "Site ID",
          },
          agent_name: {
            type: "string",
            description: "Agent name (health, security, performance, seo, content, quality, feedback, learning, supervisor, ui, e2e, user_behavior, design, social_media)",
          },
        },
        required: ["site_id", "agent_name"],
      },
    },
    {
      name: "agentminds_site_overview",
      description: "Get full overview of your site — all agents, their status, scores. Use when user asks 'site status', 'overview', 'show all agents', 'how is my site doing'.",
      inputSchema: {
        type: "object",
        properties: {
          site_id: {
            type: "string",
            description: "Site ID",
          },
        },
        required: ["site_id"],
      },
    },
    {
      name: "agentminds_status",
      description: "Check AgentMinds Central system health — is the server up, any alerts, circuit breakers. Use when user asks 'system status', 'is AgentMinds up', 'health check'.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "agentminds_register",
      description: "Register a new site with AgentMinds Central. Returns API key. Use when user says 'register', 'sign up', 'add my site', 'connect this project'.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Site URL (e.g. https://mysite.com)",
          },
          name: {
            type: "string",
            description: "Site name",
          },
        },
        required: ["url", "name"],
      },
    },
    {
      name: "agentminds_feedback",
      description:
        "Submit a quick 'was AgentMinds useful?' verdict. Call this when " +
        "the user expresses an opinion about the output of a prior tool " +
        "call — phrases like 'yes that helped', 'no this is wrong', " +
        "'kind of useful', 'sort of', or any thumbs up / down sentiment. " +
        "Also call when the user explicitly says 'agentminds-feedback' / " +
        "'feedback yes' / 'feedback no'. This is the single most valuable " +
        "signal for the project — yes/no/sort-of all help equally.",
      inputSchema: {
        type: "object",
        properties: {
          usefulness: {
            type: "string",
            enum: ["yes", "no", "sort_of"],
            description:
              "Verdict: 'yes' = solved a real problem, 'no' = wasn't " +
              "useful, 'sort_of' = partial / mixed value.",
          },
          context: {
            type: "string",
            description:
              "Which tool the verdict refers to (e.g. 'connect', " +
              "'push', 'intro'). Optional — defaults to 'unspecified'.",
          },
          note: {
            type: "string",
            description:
              "Optional free-text note. What worked, what didn't, " +
              "what was missing. Up to 500 chars.",
          },
        },
        required: ["usefulness"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Rate limit check — discovery / status / register always free.
  // agentminds_intro is the zero-arg "learn what this is" surface;
  // gating it behind rate limit broke first-time discovery for new users.
  const FREE_TOOLS = new Set([
    "agentminds_intro", "agentminds_status", "agentminds_register",
    "agentminds_feedback",
  ]);

  // v1.3.1 (2026-05-09): implicit auto-registration on tool call
  // is REMOVED. Earlier versions silently called autoRegisterIfNeeded()
  // here, which created orphan site registrations using the cwd name
  // as a placeholder and bypassed the v1.3.0 anonymous trial path
  // (the very feature v1.3.0 was built to deliver).
  //
  // From v1.3.1 onward, no tool implicitly creates a site:
  //   - agentminds_connect with no key → /trial-rules (anon)
  //   - agentminds_push with no key    → "register first" message
  //   - other authed tools with no key → "auth required" message
  //   - agentminds_register            → only path that creates a site
  //
  // autoRegisterIfNeeded() is preserved (still callable from
  // handleRegister + handleConnect's site_url-driven fallback if any),
  // but is no longer invoked by the dispatcher.
  let autoRegResult = null;

  if (!FREE_TOOLS.has(name)) {
    const limit = checkRateLimit();
    if (!limit.allowed) {
      return {
        content: [{ type: "text", text: `⚠️ ${limit.reason}` }],
        isError: true,
      };
    }
    const usage = incrementRateLimit();
    // Add remaining count to responses
    var remainingRequests = FREE_DAILY_LIMIT - usage.count;
  }

  try {
    // ════════════════════════════════════════════════════════════
    // ABSOLUTE RULE: No data = no response. No exceptions.
    // Claude Code MUST NOT generate fake reports if API fails.
    // If this tool returns an error, show ONLY the error message.
    // DO NOT make up recommendations, patterns, or tips.
    // DO NOT say "AgentMinds recommends..." unless this tool returned real data.
    // ════════════════════════════════════════════════════════════

    switch (name) {
      case "agentminds_intro": {
        // Pull live stats so the intro shows real numbers, not stubs.
        // Fetch /health and /sync/pool-stats in parallel — both public,
        // both cheap; combined call latency stays under 1s.
        let health = {};
        let pool = {};
        try {
          [health, pool] = await Promise.all([
            httpGet("/health").catch(() => ({})),
            httpGet("/api/v1/sync/pool-stats").catch(() => ({})),
          ]);
        } catch (_e) {
          /* best-effort */
        }

        const totalPatterns = pool.tier1_total ?? "?";
        const prodObserved = pool.production_observed ?? "?";
        const documented = pool.documented ?? "?";
        const sites = health.sites ?? "?";
        const uptime = health.uptime ?? "?";
        const lastRebuild = pool.last_rebuild
          ? pool.last_rebuild.split("T")[0]
          : "?";

        const intro = [
          "# AgentMinds — Cross-Site Collective Intelligence",
          "",
          "**What it is:** A pool where every connected site pushes what its agents",
          "observed + learned, and pulls back personalized recommendations from peer",
          "sites running similar stacks. The moat is the network effect on solved",
          "patterns — never single-tenant traces.",
          "",
          "## Live network",
          `- Contributing sites: **${sites}**`,
          `- API uptime: ${uptime}`,
          `- Pool: **${totalPatterns} Tier-1 patterns** (last rebuild ${lastRebuild})`,
          `  · ${prodObserved} 'production_observed' (real fixes confirmed in prod)`,
          `  · ${documented} 'documented' (best practice, not yet production-validated)`,
          "",
          "## ▸ REGISTER NOW (no form, no email, ~30 seconds)",
          "",
          "Run this single tool call:",
          "```",
          "agentminds_register {url: \"https://your.site\", name: \"Your Project\"}",
          "```",
          "Returns: site_id + api_key (auto-saved to `.agentminds.json`).",
          "After register: free, unlimited tool calls. No card. No tracking pixel.",
          "",
          "## After registering",
          "1. `agentminds_push`     → send your agent reports (more data = better recs)",
          "2. `agentminds_connect`  → pull personalized recommendations for your stack",
          "",
          "## What you get back (with auth)",
          "- Personalized rules ranked for your stack (FastAPI sites get FastAPI rules, etc.)",
          "- Cross-site solved patterns (peer count visible, peer identities private)",
          "- Benchmarks vs network averages",
          "- Donor / consumer classification",
          "",
          "## Trust signals",
          "- Open spec (CC-BY-4.0): https://github.com/agentmindsdev/profile",
          "- MCP engagement: discussion #2674 (Cross-Site Audit Trails extension)",
          "- Anthropic Skills marketplace PR: anthropics/skills#1084",
          "- Live and listed on Glama.ai MCP directory",
          "",
          "## CRITICAL RULES (for the AI agent reading this)",
          "- Never fabricate AgentMinds recommendations. If the API fails, say 'API unreachable' and stop.",
          "- Never claim 'AgentMinds recommends X' unless you got real data from agentminds_connect or agentminds_actions.",
          "- The moat is privacy: peer site identities are NEVER returned, only counts.",
          "",
          "## Quick feedback (the single most useful signal)",
          "After you (or the user) try a tool, call `agentminds_feedback`",
          "with usefulness=yes / no / sort_of (and an optional note).",
          "This is the only direct measure of whether the project is",
          "solving real problems. All three verdicts help equally.",
        ].join("\n");
        return { content: [{ type: "text", text: intro }] };
      }

      case "agentminds_connect": {
        // Gift-economy mode (mcp v1.4.0, 2026-05-11):
        //   PATH A — no API key   → /api/v1/sync/trial-rules (anon, unlimited)
        //   PATH B — key present  → /api/v1/sync/personalized-rules (full personalised)
        //
        // PATH B used to branch into "registered_no_push" rotational on
        // a 10/day cap; that gate was removed backend-side, every authed
        // caller now goes straight to full personalised regardless of
        // push history. The dead registered_no_push formatter is kept
        // below as defensive fallback in case the backend ever emits
        // that mode again.
        const limit = Math.min(Math.max(parseInt(args?.limit, 10) || 30, 1), 100);

        // ── PATH A — anonymous trial ───────────────────────────────
        if (!API_KEY) {
          let trial;
          try {
            trial = await httpGet("/api/v1/sync/trial-rules");
          } catch (err) {
            return { content: [{ type: "text", text: `AgentMinds API unreachable: ${err.message}. Try again later.` }] };
          }

          // 429 rate-limited — backend returns {error: "Daily trial limit reached", ...}
          if (trial?.error === "Daily trial limit reached") {
            const lines = [];
            lines.push("# AgentMinds — daily trial limit reached\n");
            if (trial.message) lines.push(trial.message + "\n");
            const regUrl = trial.next_step?.register_url || "https://agentminds.dev/onboard";
            lines.push(`→ Register a free account: ${regUrl}`);
            lines.push("→ Then run: `agentminds_register` (with url + name)\n");
            lines.push("Registered users get 10 personalised recommendations/day. Push site data for unlimited access.");
            return { content: [{ type: "text", text: lines.join("\n") }] };
          }

          // Non-trial response shape (some other 4xx/5xx) — surface raw error.
          if (!trial || trial.mode !== "trial_anonymous") {
            const detail = trial?.detail || trial?.error || trial?.raw || "unknown error";
            return { content: [{ type: "text", text: `AgentMinds API error: ${detail}` }] };
          }

          // Format trial_anonymous response.
          const lines = [];
          lines.push("# 🌐 AgentMinds Network — Anonymous Trial Mode\n");
          const totalPatterns = trial.pool_stats?.total_patterns ?? "?";
          lines.push(`Showing ${trial.patterns?.length || 0} of ${totalPatterns} popular production-observed patterns.`);
          if (trial.rate_limit) {
            lines.push(`(${trial.rate_limit.calls_today}/${trial.rate_limit.limit_per_day} trial calls used today; resets in ${trial.rate_limit.resets_in_hours}h.)`);
          }
          lines.push("");

          const cats = trial.pool_stats?.top_categories || [];
          if (cats.length > 0) {
            lines.push("## Pool depth — top categories");
            for (const c of cats.slice(0, 5)) {
              lines.push(`- **${c.category}**: ${c.count} patterns`);
            }
            lines.push("");
          }

          lines.push("## Recommendations (popular in the network)");
          lines.push("");
          (trial.patterns || []).forEach((p, i) => {
            const score = p.relevance_score != null ? ` (score ${p.relevance_score})` : "";
            lines.push(`### ${i + 1}. [${p.agent || "?"} / ${p.category || "?"}]${score}`);
            if (p.if)   lines.push(`- **IF:** ${truncate(p.if, 240)}`);
            if (p.then) lines.push(`- **THEN:** ${truncate(p.then, 240)}`);
            if (p.reversibility) lines.push(`- **Reversibility:** ${p.reversibility}`);
            if (p.production_signal_tier) lines.push(`- **Tier:** ${p.production_signal_tier}`);
            lines.push("");
          });

          lines.push("---");
          if (trial.next_step?.message) lines.push(trial.next_step.message + "\n");
          const regUrl = trial.next_step?.register_url || "https://agentminds.dev/onboard";
          lines.push(`→ Run: \`agentminds_register\` (with url + name)`);
          lines.push(`→ Or visit: ${regUrl}`);

          appendFeedback(lines);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // ── PATH B / C — authenticated → /personalized-rules ───────
        let data;
        try {
          data = await httpGet(`/api/v1/sync/personalized-rules?limit=${limit}`);
        } catch (err) {
          return { content: [{ type: "text", text: `AgentMinds API unreachable: ${err.message}. Try again later.` }] };
        }

        // 401/403 — auth failure. FastAPI raises HTTPException(403, "...")
        // with body {detail: "Valid API key required..."}. Distinguish from
        // success body (which never has `detail`).
        if (data?.detail && typeof data.detail === "string") {
          return {
            content: [{
              type: "text",
              text: [
                "# AgentMinds — authentication failed",
                "",
                `${data.detail}`,
                "",
                "→ Check your `AGENTMINDS_API_KEY` environment variable.",
                "→ Or run `agentminds_register` to create a new account.",
              ].join("\n"),
            }],
          };
        }

        // PATH B — registered, no push history. Backend returns
        // mode=registered_no_push with a 10/day rotational slice.
        if (data?.mode === "registered_no_push") {
          const lines = [];
          lines.push("# 👤 AgentMinds — Registered Mode (no push yet)\n");
          if (data.site_id) lines.push(`Site: \`${data.site_id}\``);
          lines.push(`Daily limit: ${data.daily_limit ?? 10} patterns (rotates daily)`);
          if (data.next_rotation_at) lines.push(`Next rotation: ${data.next_rotation_at}`);
          lines.push("");

          lines.push(`## Today's rotation (${data.patterns_returned ?? (data.patterns?.length || 0)} patterns)`);
          lines.push("");
          (data.patterns || []).forEach((p, i) => {
            const score = p.relevance_score != null ? ` (score ${p.relevance_score})` : "";
            lines.push(`### ${i + 1}. [${p.agent || "?"} / ${p.category || "?"}]${score}`);
            if (p.if)   lines.push(`- **IF:** ${truncate(p.if, 240)}`);
            if (p.then) lines.push(`- **THEN:** ${truncate(p.then, 240)}`);
            if (p.reversibility) lines.push(`- **Reversibility:** ${p.reversibility}`);
            lines.push("");
          });

          lines.push("---");
          if (data.next_step?.message) lines.push(data.next_step.message + "\n");

          // v1.3.3 — "Why push?" comparison so a user reading this
          // response sees the concrete tier-up value, not just a CTA.
          // Mirrors the docs/3-tier ladder shipped on agentminds.dev.
          lines.push("");
          lines.push("## 📊 Why push?");
          lines.push("");
          lines.push("| Mode | Daily limit | Recommendation type |");
          lines.push("|---|---|---|");
          lines.push("| **You're here:** Registered | 10 rotational | Daily picks from top 50 of the public pool |");
          lines.push("| **After push:** Personalised | Unlimited | Stack-matched (FastAPI / Flask / Django / Next.js / etc.) + cross-site references + negative evidence |");
          lines.push("");
          lines.push("Push your first agent report (1 minute):");
          lines.push("- Run `agentminds_push` with `reports: [{...}]`");
          lines.push("- See the tool description for the envelope schema");
          lines.push("- Or visit https://agentminds.dev/docs for full guide");

          appendFeedback(lines);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // PATH C — pushed, full personalised flow (ARP v1.3 shape:
        // top_production_observed + top_documented + negative_evidence +
        // _meta.stats). UNCHANGED behaviour from v1.2.x except formatter
        // now reads the v1.3 split arrays explicitly.
        const lines = [];
        lines.push("# ✨ AgentMinds — Personalised Recommendations\n");
        if (data.site_id)   lines.push(`Site: \`${data.site_id}\` (${data.site_type || "?"})`);
        if (data.total_rules_in_network != null && data.total_relevant_to_you != null) {
          lines.push(`Pool: ${data.total_rules_in_network} patterns total, ${data.total_relevant_to_you} relevant to your stack`);
        }
        const peer = data._meta?.stats?.peer_sites_solving_same;
        if (peer != null) lines.push(`Cross-site: ${peer} peer site${peer === 1 ? "" : "s"} with overlapping patterns`);
        lines.push("");

        const prodObs = data.top_production_observed || [];
        if (prodObs.length > 0) {
          lines.push(`## 🔥 Production-observed (${prodObs.length})`);
          lines.push("");
          prodObs.forEach((p, i) => {
            const score = p.relevance_score != null ? ` (score ${p.relevance_score})` : "";
            lines.push(`### ${i + 1}. [${p.agent || "?"} / ${p.category || "?"}]${score}`);
            if (p.if)   lines.push(`- **IF:** ${truncate(p.if, 240)}`);
            if (p.then) lines.push(`- **THEN:** ${truncate(p.then, 240)}`);
            if (p.reversibility) lines.push(`- **Reversibility:** ${p.reversibility}`);
            lines.push("");
          });
        }

        const docs = data.top_documented || [];
        if (docs.length > 0) {
          lines.push(`## 📚 Documented (${docs.length})`);
          lines.push("");
          docs.forEach((p, i) => {
            lines.push(`### ${i + 1}. [${p.agent || "?"} / ${p.category || "?"}]`);
            if (p.if)   lines.push(`- **IF:** ${truncate(p.if, 240)}`);
            if (p.then) lines.push(`- **THEN:** ${truncate(p.then, 240)}`);
            lines.push("");
          });
        }

        const negEv = data.negative_evidence || [];
        if (negEv.length > 0) {
          const reasonCounts = {};
          for (const e of negEv) {
            reasonCounts[e.reason] = (reasonCounts[e.reason] || 0) + 1;
          }
          lines.push(`## 🚫 Filtered out (${negEv.length} patterns suppressed)`);
          for (const [reason, count] of Object.entries(reasonCounts)) {
            lines.push(`- **${reason}**: ${count}`);
          }
          lines.push("");
        }

        // Backwards-compat: if the response is from a pre-v1.3 backend
        // that still emits only `top_rules`, surface those too so older
        // deployments still produce useful output.
        if (prodObs.length === 0 && docs.length === 0 && Array.isArray(data.top_rules)) {
          lines.push(`## Top rules (${data.top_rules.length})`);
          lines.push("");
          data.top_rules.forEach((p, i) => {
            const score = p.relevance_score != null ? ` (score ${p.relevance_score})` : "";
            lines.push(`### ${i + 1}. [${p.agent || "?"} / ${p.category || "?"}]${score}`);
            if (p.if)   lines.push(`- **IF:** ${truncate(p.if, 240)}`);
            if (p.then) lines.push(`- **THEN:** ${truncate(p.then, 240)}`);
            lines.push("");
          });
        }

        appendFeedback(lines);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "agentminds_push": {
        if (!API_KEY) {
          return {
            content: [{
              type: "text",
              text: [
                "# Cannot push — no API key found",
                "",
                "To push site data into the AgentMinds network, you need a key first.",
                "",
                "**Two paths:**",
                "",
                "1. Register from the terminal (creates a site, returns a key):",
                "   `agentminds_register` with `url` + `name`.",
                "",
                "2. Already have a key (e.g. from agentminds.dev/onboard)?",
                "   Set `AGENTMINDS_API_KEY=sk_...` in your env or",
                "   `.agentminds.json`, then call this tool again.",
                "",
                "**Or browse without registering:** run `agentminds_connect`",
                "for the anonymous trial (top network patterns, no signup).",
              ].join("\n"),
            }],
          };
        }
        if (args?.brain_export_url) {
          // Let Central pull from the URL
          const data = await httpPost("/api/v1/connect", {
            brain_export_url: args.brain_export_url,
          });
          const pushed = data.data_pushed || {};
          return {
            content: [{ type: "text", text: `# Data Pushed to AgentMinds\n\nAgents: ${pushed.agents || 0}\nPatterns: ${pushed.patterns || 0}\nURL: ${pushed.url || args.brain_export_url}\n\nYour data is now in the collective pool. Other sites benefit from your patterns and solutions.\nUse agentminds_connect to get your recommendations.` }],
          };
        }

        if (args?.reports && Array.isArray(args.reports)) {
          // v1.3.2 (2026-05-09) push fix:
          //
          // Earlier versions sent `site_id: "auto"` literal string to
          // /sync/bulk and read `data.status || "ok"` from the response.
          // Backend's /sync/bulk requires payload.site_id to match the
          // site bound to the API key (sanitize_site_id + _verify_site
          // chain at api.py:1069-1076), so the literal "auto" string was
          // rejected by _verify_site. The MCP layer then displayed
          // "Status: ok" via the fallback regardless — anti-hallucination
          // violation, push silently failed.
          //
          // v1.3.2 resolves the real site_id from /sync/me first, sends
          // it in the bulk payload, and surfaces the actual backend
          // response (data_quality grade + stored count + issues) in the
          // tool output. No more silent success.

          // Step 1 — resolve real site_id from API key.
          let me;
          try {
            me = await httpGet("/api/v1/sync/me");
          } catch (err) {
            return {
              content: [{ type: "text", text: `# Push failed — API unreachable\n\n${err.message}\nTry again in a moment.` }],
            };
          }
          if (me?.detail || !me?.site_id) {
            const detailMsg = (me && me.detail) ? me.detail : "API returned no site_id";
            return {
              content: [{ type: "text", text: [
                "# Push failed — could not resolve site_id from API key",
                "",
                `Backend response: ${detailMsg}`,
                "",
                "→ Check your `AGENTMINDS_API_KEY` is valid.",
                "→ Or run `agentminds_register` to create a new account.",
              ].join("\n") }],
            };
          }
          const siteId = me.site_id;

          // Step 2 — push with the real site_id, not "auto".
          const data = await httpPost("/api/v1/sync/bulk", {
            site_id: siteId,
            reports: args.reports,
          });

          // Step 3 — anti-hallucination: surface real backend response,
          // never display hardcoded "ok". If the backend returned a
          // FastAPI error envelope ({detail: "..."}) or a non-ok status,
          // show it as a failure.
          if (!data || data.detail || data.status !== "ok") {
            const detail = (data && (data.detail || data.error)) || "no status field";
            return {
              content: [{ type: "text", text: [
                "# Push not accepted by backend",
                "",
                `Site: \`${siteId}\``,
                `Reports sent: ${args.reports.length}`,
                `Backend response: ${detail}`,
                "",
                "Raw response:",
                "```json",
                JSON.stringify(data, null, 2).slice(0, 1200),
                "```",
              ].join("\n") }],
            };
          }

          // Step 4 — successful push, format with real data_quality.
          const dq = data.data_quality || {};
          const lines = [];
          lines.push("# ✅ Data pushed");
          lines.push("");
          lines.push(`Site:          \`${siteId}\``);
          lines.push(`Reports sent:  ${args.reports.length}`);
          if (data.stored !== undefined) lines.push(`Stored:        ${data.stored}`);
          lines.push(`Backend status: ${data.status}`);
          if (dq.grade) {
            lines.push("");
            lines.push("## Data quality (server-graded)");
            lines.push(`- Grade:           ${dq.grade}`);
            if (dq.average_score != null) lines.push(`- Average score:   ${dq.average_score}`);
            if (dq.accepted_reports != null && dq.total_reports != null) {
              lines.push(`- Accepted:        ${dq.accepted_reports} / ${dq.total_reports}`);
            }
            if (dq.low_quality_reports != null) lines.push(`- Low quality:     ${dq.low_quality_reports}`);
            if (Array.isArray(dq.issues) && dq.issues.length > 0) {
              lines.push("");
              lines.push("### Quality issues flagged by backend");
              for (const issue of dq.issues.slice(0, 8)) {
                if (typeof issue === "string") lines.push(`- ${issue}`);
                else lines.push(`- ${JSON.stringify(issue)}`);
              }
            }
          }
          lines.push("");
          lines.push("→ Run `agentminds_connect` to pull personalised recommendations matched to your stack.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        return {
          content: [{ type: "text", text: "Provide either brain_export_url or reports array to push data." }],
        };
      }

      case "agentminds_actions": {
        if (!API_KEY) {
          return {
            content: [{
              type: "text",
              text: [
                "# Authentication required",
                "",
                "`agentminds_actions` returns the personalized action plan",
                "for your site, which requires authentication.",
                "",
                "→ Run `agentminds_register` to create a site, or set",
                "  `AGENTMINDS_API_KEY=sk_...` if you already have one.",
                "→ For a no-signup preview of the network, use",
                "  `agentminds_connect` (anonymous trial mode).",
              ].join("\n"),
            }],
          };
        }
        const siteId = args?.site_id || "";
        let data;
        if (siteId) {
          data = await httpGet(`/api/v1/sync/actions/${siteId}`);
        } else {
          // Use connect endpoint which auto-detects site from key
          data = await httpPost("/api/v1/connect", {});
        }
        return {
          content: [{ type: "text", text: formatActions(data) }],
        };
      }

      case "agentminds_agent_detail": {
        if (!API_KEY) {
          return {
            content: [{
              type: "text",
              text: [
                "# Authentication required",
                "",
                "`agentminds_agent_detail` returns per-agent data for an",
                "authenticated site.",
                "",
                "→ Run `agentminds_register` first or set",
                "  `AGENTMINDS_API_KEY=sk_...`.",
              ].join("\n"),
            }],
          };
        }
        const data = await httpGet(`/api/v1/sync/sites/${args.site_id}/agents/${args.agent_name}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "agentminds_site_overview": {
        if (!API_KEY) {
          return {
            content: [{
              type: "text",
              text: [
                "# Authentication required",
                "",
                "`agentminds_site_overview` returns the dashboard view of",
                "an authenticated site.",
                "",
                "→ Run `agentminds_register` first or set",
                "  `AGENTMINDS_API_KEY=sk_...`.",
              ].join("\n"),
            }],
          };
        }
        const data = await httpGet(`/api/v1/sync/sites/${args.site_id}`);
        const meta = data.meta || {};
        const agents = data.agents || {};

        const lines = [];
        lines.push(`# ${meta.site_name || args.site_id}`);
        lines.push(`URL: ${meta.site_url || "?"}`);
        lines.push(`Type: ${meta.site_type || "?"}`);
        lines.push(`Agents: ${meta.agent_count || Object.keys(agents).length}`);
        lines.push(`Last report: ${meta.last_report || "?"}`);
        lines.push("");
        lines.push("| Agent | Severity | Warnings | Recs |");
        lines.push("|-------|----------|----------|------|");

        for (const [agentName, agentData] of Object.entries(agents)) {
          const sev = agentData.severity || "?";
          const warns = agentData.warnings || 0;
          const recs = agentData.recommendations || 0;
          lines.push(`| ${agentName} | ${sev} | ${warns} | ${recs} |`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "agentminds_status": {
        const health = await httpGet("/health");
        const guardian = await httpGet("/api/v1/guardian/status");

        const lines = [];
        lines.push("# AgentMinds System Status");
        lines.push(`Health: ${health.status || "?"}`);
        lines.push(`Sites: ${health.sites || 0}`);
        lines.push(`Open circuits: ${(health.open_circuits || []).length}`);
        lines.push(`Recent alerts (1h): ${health.recent_alerts_1h || 0}`);
        lines.push(`Uptime quality: ${guardian.uptime_quality || "?"}`);
        if (guardian.last_pipeline_run) {
          lines.push(`Last pipeline: ${guardian.last_pipeline_run.timestamp || "?"} (${guardian.last_pipeline_run.status || "?"})`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "agentminds_register": {
        const info = detectProjectInfo();
        const regUrl = args?.url || info.url;
        const regName = args?.name || info.name || path.basename(process.cwd());

        if (!regUrl) {
          return {
            content: [{ type: "text", text: "# URL required to register\n\nNo site URL detected. Please pass the `url` parameter (e.g. https://mysite.com)." }],
          };
        }

        const data = await httpPost("/api/v1/sync/onboard", { url: regUrl, name: regName });

        if (data.api_key) {
          // Auto-save key
          API_KEY = data.api_key;
          const saved = saveKey(data.site_id, data.api_key, regUrl, regName);

          // v1.3.3 — comprehensive save-key guidance + recovery flow.
          // Earlier versions just said "API key auto-saved to
          // .agentminds.json". UAT (2026-05-09) showed users had no
          // backup path if the file got cleaned/lost.
          const lines = [];
          lines.push("# ✅ Registration successful");
          lines.push("");
          lines.push(`Site:          \`${data.site_id}\``);
          if (data.site_type)     lines.push(`Site type:     ${data.site_type}`);
          if (data.enabled_agents && data.enabled_agents.length) {
            lines.push(`Enabled agents: ${data.enabled_agents.join(", ")}`);
          }
          lines.push("");
          lines.push("## 🔑 API Key");
          lines.push("");
          lines.push("```");
          lines.push(data.api_key);
          lines.push("```");
          lines.push("");
          lines.push("⚠️  Save this key — you cannot retrieve it again.");
          lines.push("");
          lines.push("## Storage options");
          lines.push("");
          if (saved) {
            lines.push("**1. Project file** *(already done — auto-saved)*");
            lines.push(`   \`.agentminds.json\` written in the current directory`);
            lines.push("   with `chmod 600` on POSIX. Add to `.gitignore` if you");
            lines.push("   commit this project.");
          } else {
            lines.push("**1. Project file** *(recommended — auto-save failed,");
            lines.push("   you need to do this manually)*");
            lines.push("   Create `.agentminds.json` in your project root:");
            lines.push("   ```json");
            lines.push("   {");
            lines.push(`     "api_key": "${data.api_key}",`);
            lines.push(`     "site_id": "${data.site_id}"`);
            lines.push("   }");
            lines.push("   ```");
            lines.push("   Add `.agentminds.json` to `.gitignore`.");
          }
          lines.push("");
          lines.push("**2. Environment variable** *(for CI/CD or shared shells)*");
          lines.push("   ```bash");
          lines.push(`   export AGENTMINDS_API_KEY=${data.api_key}`);
          lines.push("   ```");
          lines.push("");
          lines.push("**3. Password manager** *(1Password / Bitwarden / KeePass)*");
          lines.push(`   Entry name: \`AgentMinds ${data.site_id}\``);
          lines.push("");
          lines.push("## 🚨 Lost your key?");
          lines.push("");
          lines.push(`Email \`hello@agentminds.dev\` with your site URL`);
          lines.push("(`" + regUrl + "`). We can verify ownership and reset.");
          lines.push("");
          lines.push("## 📚 Next steps");
          lines.push("");
          lines.push("1. Run `agentminds_connect` to verify the key works");
          lines.push("   (you'll see Registered Mode with 10 daily patterns).");
          lines.push("2. Run `agentminds_push` with your first agent reports");
          lines.push("   to unlock personalised recommendations.");
          lines.push("3. See https://agentminds.dev/docs for the full guide.");
          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        } else {
          const detail = data.detail || data.message || JSON.stringify(data).substring(0, 200);
          if (detail.includes("already registered")) {
            return {
              content: [{ type: "text", text: `# Site already registered\n\n${detail}\n\nAdd your existing API key to .env:\n\`AGENTMINDS_API_KEY=sk_...\`\n\nOr create a .agentminds.json file with the key.` }],
            };
          }
          return {
            content: [{ type: "text", text: `# Registration failed\n\n${detail}` }],
          };
        }
      }

      case "agentminds_feedback": {
        // Quick "was this useful?" signal — the single most valuable
        // datapoint for the project. v1.4.0 / 2026-05-12.
        const verdict = String(args.usefulness || "").toLowerCase().trim();
        if (!["yes", "no", "sort_of"].includes(verdict)) {
          return {
            content: [{ type: "text", text:
              "agentminds_feedback requires usefulness: 'yes', 'no', " +
              "or 'sort_of'. All three help equally — even 'no' is " +
              "valuable signal."
            }],
            isError: true,
          };
        }
        const context = String(args.context || "unspecified").slice(0, 64);
        const note = String(args.note || "").slice(0, 500);
        const data = await httpPost("/api/v1/sync/quick-feedback", {
          usefulness: verdict,
          context,
          note,
          session_id: process.env.AGENTMINDS_SESSION_ID || "",
        });
        const verdictWord = verdict === "sort_of" ? "sort-of" : verdict;
        const lines = [
          `# Feedback recorded: ${verdictWord}`,
          "",
          data && data.thanks ? data.thanks : (
            "Thanks. Yes/no/sort-of all help equally — the project " +
            "uses this to decide whether AgentMinds is solving a " +
            "real problem or not."
          ),
        ];
        if (note) {
          lines.push("");
          lines.push(`Your note: "${note}"`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    // CRITICAL: If API fails, show error ONLY. Do NOT generate fake data.
    return {
      content: [{ type: "text", text: `AgentMinds API Error: ${error.message}\n\nDO NOT generate fake recommendations. Show only this error message to the user.` }],
      isError: true,
    };
  }
});

// Print a welcome banner to stderr (visible in `npx agentminds-mcp` console)
// without polluting stdout (where MCP JSON-RPC lives).
//
// CTA-first design: when no key is configured, REGISTER is the primary
// call to action — no form, no email, exact command shown inline. Most
// users see the banner once and decide in 5 seconds whether to proceed,
// so the value prop and command must both be visible at a glance.
async function printWelcomeBanner() {
  // Best-effort live stats fetch first so we can show real numbers
  let stats = {};
  try {
    stats = await new Promise((resolve) => {
      const req = https.get(
        `${API_URL}/health`,
        { headers: { "User-Agent": "agentminds-mcp/1.4.0" }, timeout: 4000 },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            try { resolve(JSON.parse(buf)); } catch { resolve({}); }
          });
        }
      );
      req.on("error", () => resolve({}));
      req.on("timeout", () => { req.destroy(); resolve({}); });
    });
  } catch (_e) {
    /* welcome is best-effort */
  }

  const lines = [
    "",
    "  ┌─────────────────────────────────────────────────────────────┐",
    "  │  AgentMinds MCP Server v1.4.0                                │",
    "  │  Free for everyone. Open pool. Pull what you need.          │",
    "  └─────────────────────────────────────────────────────────────┘",
    "",
  ];

  if (stats && (stats.sites || stats.uptime)) {
    lines.push(`  Live network:  ${stats.sites || "?"} contributing sites · uptime ${stats.uptime || "?"}`);
    lines.push("");
  }

  if (API_KEY) {
    lines.push(`  Auth:  configured (${API_KEY.slice(0, 12)}...)`);
    lines.push("");
    lines.push("  Tools:  agentminds_push      → contribute back (voluntary)");
    lines.push("          agentminds_connect   → pull personalised recommendations");
    lines.push("          agentminds_feedback  → 'was this useful?' verdict");
    lines.push("          agentminds_intro     → zero-arg discovery");
  } else {
    lines.push("  Auth:  not configured  (anonymous mode is fine — unlimited)");
    lines.push("");
    lines.push("  ▸ Pull immediately, no signup:");
    lines.push("      agentminds_connect  (returns top patterns from the pool)");
    lines.push("");
    lines.push("  ▸ Want stack-matched personalised recommendations?");
    lines.push("      agentminds_register {url: \"https://your.site\", name: \"Your Project\"}");
    lines.push("");
    lines.push("    Free. No card. No upgrade prompts. Pushing back is optional.");
    lines.push("");
    lines.push("  ▸ Already have a key?  Set in .env:  AGENTMINDS_API_KEY=sk_...");
    lines.push("  ▸ Just exploring?      agentminds_intro  (zero-arg, no key needed)");
  }

  lines.push("");
  lines.push("  Spec (CC-BY-4.0):  https://github.com/agentmindsdev/profile");
  lines.push(`  API:               ${API_URL}`);
  lines.push("");

  process.stderr.write(lines.join("\n") + "\n");
}

// Start server
async function main() {
  await printWelcomeBanner();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
