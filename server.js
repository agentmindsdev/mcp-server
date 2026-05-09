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
// Rate limiting — daily request limit per key
// ══════════════════════════════════════════════════════════════

const FREE_DAILY_LIMIT = 1; // No key: 1 request/day (trial)
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
  // Has key → unlimited
  if (API_KEY) {
    return { allowed: true, remaining: "unlimited" };
  }

  // No key → 1 request/day trial
  const data = getRateLimit();
  if (data.count >= FREE_DAILY_LIMIT) {
    return { allowed: false, reason: "Free trial limit reached (1/day). Register for unlimited access: POST https://api.agentminds.dev/api/v1/sync/onboard" };
  }

  return { allowed: true, remaining: FREE_DAILY_LIMIT - data.count };
}

// ══════════════════════════════════════════════════════════════
// HTTP helpers
// ══════════════════════════════════════════════════════════════

// User-Agent identifies MCP traffic in Render server access logs so we
// can measure "downloads → real API calls → registers" funnel without
// adding a separate telemetry endpoint.
const MCP_UA = "agentminds-mcp/1.3.0";

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
  { name: "agentminds", version: "1.3.0" },
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

WORKS WITHOUT REGISTRATION. Three modes based on auth + push state:

1. ANONYMOUS (no API key in env):
   Returns 3 popular production-observed patterns from the network.
   Rate limited to 3 calls/day per IP at the backend.
   Includes pool stats + register CTA.

2. REGISTERED (API key set, no push history):
   Returns up to 10 personalized recommendations/day, daily rotation.
   Selected from the top-50 pool, rotated deterministically per site_id.
   Includes push CTA for unlimited access.

3. PUSHED (API key + previous agentminds_push call):
   Returns unlimited stack-matched personalized recommendations.
   Includes cross-site references, negative evidence, reversibility
   labels, full ARP v1.3 response shape.

CRITICAL ANTI-HALLUCINATION RULES (preserved from v1.2.x):
1. NEVER fabricate recommendations.
2. ALWAYS use the tool's actual response — do not invent patterns.
3. If the API is unreachable, output "API unreachable" — do not improvise.
4. The trial-mode response is REAL data from the pool — show it as-is.
5. Distinguish in your output:
   - trial_anonymous mode  = "popular in the network"
   - registered_no_push mode = "rotational selection, 10/day"
   - personalized mode     = "matched to your stack"`,
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max patterns to return (default 10, capped at 20). Anonymous mode always returns 3 regardless.",
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
      description: `Push detailed agent data to AgentMinds Central. IMPORTANT: Send FULL data, not just names and scores.

Each agent report MUST include:
- severity: "critical" | "warning" | "info"
- summary: what the agent found (1-2 sentences)
- metrics: key numbers (e.g. {total_leads: 567, bounce_rate: 3.5, open_rate: 12})
- warnings: array of issues found [{severity: "warning", message: "..."}]
- recommendations: array of suggested fixes [{title: "...", priority: "high"}]
- memory.learned_patterns: what the agent learned [{pattern: "...", category: "...", confidence: 0.9, status: "active", impact: "high"}]

The MORE detail you send, the BETTER recommendations you get back. Empty data = empty recommendations.

Example: {agent: "lead_hunter", report: {severity: "warning", summary: "567 leads found but 0% open rate", metrics: {total_leads: 567, emails_found: 230, open_rate: 0, bounce_rate: 8.3}, warnings: [{severity: "critical", message: "0% email open rate - emails likely going to spam"}], recommendations: [{title: "Warm up email domain before bulk sending", priority: "critical"}]}, memory: {learned_patterns: [{pattern: "cold_email_spam", category: "email_deliverability", confidence: 0.9, status: "active", impact: "critical", detail: "Bulk cold emails without domain warmup go to spam"}]}}`,
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
  ]);

  // Auto-register on first real tool call (push/connect/actions/etc).
  // The function is a no-op if a key already exists; if no URL can be
  // detected from the project context it returns silently and the
  // normal tool flow handles the no-key case.
  // Skip for discovery tools (intro/status) and for register itself
  // (which would loop) — those work fine without a key.
  let autoRegResult = null;
  if (!API_KEY && !FREE_TOOLS.has(name)) {
    autoRegResult = await autoRegisterIfNeeded();
  }

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
        ].join("\n");
        return { content: [{ type: "text", text: intro }] };
      }

      case "agentminds_connect": {
        // Tier-aware pull-first model (mcp v1.3.0, backend a8c23b3):
        //   PATH A — no API key      → /api/v1/sync/trial-rules (anon, 3/day)
        //   PATH B — key, no push    → /api/v1/sync/personalized-rules (10/day rotational)
        //   PATH C — key + push      → /api/v1/sync/personalized-rules (full personalised v1.3)
        //
        // Backend auto-branches B vs C based on the site's last_report_at.
        // The MCP only needs to detect A vs (B|C) by API_KEY presence; the
        // returned payload's `mode` field tells us which formatter to use.
        const limit = Math.min(Math.max(parseInt(args?.limit, 10) || 10, 1), 20);

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
          if (trial.next_step?.pricing_url) lines.push(`→ Pricing: ${trial.next_step.pricing_url}`);

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
          lines.push("→ Push your agent reports with `agentminds_push` for unlimited stack-matched personalised access.");
          if (data._meta?.upgrade_url) lines.push(`→ Pricing: ${data._meta.upgrade_url}`);

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

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "agentminds_push": {
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
          // Push reports directly via bulk endpoint
          const data = await httpPost("/api/v1/sync/bulk", {
            site_id: "auto", // server determines from key
            reports: args.reports,
          });
          return {
            content: [{ type: "text", text: `# Data Pushed\n\nReports sent: ${args.reports.length}\nStatus: ${data.status || "ok"}\n\nUse agentminds_connect to get your recommendations.` }],
          };
        }

        return {
          content: [{ type: "text", text: "Provide either brain_export_url or reports array to push data." }],
        };
      }

      case "agentminds_actions": {
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
        const data = await httpGet(`/api/v1/sync/sites/${args.site_id}/agents/${args.agent_name}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "agentminds_site_overview": {
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

          return {
            content: [{
              type: "text",
              text: [
                "# ✅ Registration successful",
                "",
                `Site ID: ${data.site_id}`,
                `Site Type: ${data.site_type}`,
                `Enabled Agents: ${(data.enabled_agents || []).join(", ")}`,
                "",
                saved ? "API key auto-saved to .agentminds.json" : `API Key: ${data.api_key} — add to .env: AGENTMINDS_API_KEY=${data.api_key}`,
                "",
                "Next: call `agentminds_push` to send your agent reports, then `agentminds_connect` to pull personalised recommendations.",
              ].join("\n"),
            }],
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
        { headers: { "User-Agent": "agentminds-mcp/1.3.0" }, timeout: 4000 },
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
    "  │  AgentMinds MCP Server v1.3.0                                │",
    "  │  Cross-site pattern pool for production AI agent failures   │",
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
    lines.push("  Tools:  agentminds_push     → send your agent reports");
    lines.push("          agentminds_connect  → pull personalized recommendations");
    lines.push("          agentminds_intro    → zero-arg discovery");
  } else {
    lines.push("  Auth:  not configured");
    lines.push("");
    lines.push("  ▸ REGISTER your project (no form, no email, ~30 seconds):");
    lines.push("      agentminds_register {url: \"https://your.site\", name: \"Your Project\"}");
    lines.push("");
    lines.push("    Free, unlimited tool calls after register. No card. No tracking pixel.");
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
