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

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL + path);
    const headers = { "Accept": "application/json" };
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
  { name: "agentminds", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "agentminds_connect",
      description: `Connect to AgentMinds Central — fully automatic.

CRITICAL RULES:
1. You MUST send your learned data FIRST before getting any recommendations
2. If this tool returns an error or "no_data", show ONLY the error message
3. DO NOT generate fake recommendations if the API fails or times out
4. DO NOT say "AgentMinds recommends..." unless you received real data from this tool
5. If you cannot reach the API, say "AgentMinds'a bağlanılamadı" — nothing else

If no key: register first, then push data, then get recommendations.
If has key: push data → get recommendations.

Before calling this, collect DETAILED agent data from this project:
- For each agent/module: what it does, its metrics, any issues found
- Warnings and errors discovered
- Patterns learned
- Use agentminds_push to send detailed data FIRST, then connect for recommendations.
The more data you send, the better recommendations you get.`,
      inputSchema: {
        type: "object",
        properties: {
          site_url: {
            type: "string",
            description: "Site URL for registration (e.g. https://mysite.com). Only needed if auto-detection fails.",
          },
          brain_export_url: {
            type: "string",
            description: "URL to pull brain data from (e.g. https://api.mysite.com/api/v1/brain/export). Optional.",
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
      description: "Get full overview of your site — all agents, their status, scores. Use when user asks 'site durumu', 'genel durum', 'tüm agentları göster'.",
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
      description: "Check AgentMinds Central system health — is the server up, any alerts, circuit breakers. Use when user asks 'sistem durumu', 'AgentMinds çalışıyor mu?'.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "agentminds_register",
      description: "Register a new site with AgentMinds Central. Returns API key. Use when user says 'kayıt ol', 'register', 'yeni site ekle'.",
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

  // Rate limit check (status + register always free)
  if (name !== "agentminds_status" && name !== "agentminds_register") {
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
      case "agentminds_connect": {
        const lines = [];

        // STEP 1: No key → free scan first, then offer registration
        if (!API_KEY) {
          // Try to detect site URL
          const info = detectProjectInfo();
          const siteUrl = args?.site_url || info.url;

          if (!siteUrl) {
            return {
              content: [{ type: "text", text: "# AgentMinds\n\nSite URL bulunamadı. Lütfen site_url parametresi ver (örn: https://mysite.com)\n\nYa da .env dosyasına SITE_URL=https://... ekle." }],
            };
          }

          // Free scan — no registration needed
          lines.push("# AgentMinds — Ücretsiz Site Taraması\n");
          lines.push(`Taranıyor: ${siteUrl}\n`);

          const scan = await httpPost("/api/v1/free-scan", { url: siteUrl });

          if (scan.error) {
            lines.push(`Hata: ${scan.error}`);
            return { content: [{ type: "text", text: lines.join("\n") }] };
          }

          lines.push(`## Sonuç: ${scan.grade} (${scan.overall_score}/100)\n`);
          lines.push(`Yanıt süresi: ${scan.performance?.response_time_ms || "?"}ms`);
          if (scan.tech?.length) lines.push(`Teknoloji: ${scan.tech.join(", ")}`);
          lines.push("");

          // Security
          lines.push(`### Güvenlik (${scan.security?.score || 0}/100)\n`);
          for (const issue of (scan.security?.issues || [])) {
            lines.push(`- **[${issue.severity}]** ${issue.message}`);
          }
          lines.push("");

          // SEO
          lines.push(`### SEO (${scan.seo?.score || 0}/100)\n`);
          for (const issue of (scan.seo?.issues || [])) {
            lines.push(`- **[${issue.severity}]** ${issue.message}`);
          }
          lines.push("");

          // Locked features teaser
          const totalIssues = (scan.security?.issues?.length || 0) + (scan.seo?.issues?.length || 0);
          lines.push("---");
          lines.push("### 🔒 Ücretsiz Kayıt ile Açılan Özellikler\n");
          lines.push(`- **${totalIssues} sorun için hazır fix kodları** (kopyala-yapıştır)`);
          lines.push("- **200+ siteden kanıtlanmış çözümler** (cross-site zeka)");
          lines.push("- **Her 6 saatte otomatik tarama** (sürekli izleme)");
          lines.push("- **15 AI ajan** (Health, Security, Performance, SEO, Content, Quality...)");
          lines.push("- **Benchmark** (benzer sitelerle karşılaştırma)");
          lines.push("- **Trend analizi** (ne iyileşiyor, ne kötüleşiyor)");
          lines.push("- **Proven playbook** (en etkili 20 fix)");
          lines.push("- **Ajan güncelleme** (bilgi havuzundan pattern'ler öğren)");
          lines.push("- **Kolektif zeka** (tüm sitelerin deneyiminden faydalanma)");
          lines.push("");
          lines.push("**Kayıt ol:** 'AgentMinds'a kayıt ol' de veya `agentminds_register` kullan. Ücretsiz.");

          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // STEP 2: Has key → full connect (push data + get recommendations)
        const data = await httpPost("/api/v1/connect", {
          brain_export_url: args?.brain_export_url || "",
        });

        if (data.error === "no_data" || data.error === "no_patterns") {
          lines.push("# AgentMinds — Önce Verilerini Gönder!\n");
          lines.push("**Kural: Önce ver, sonra al.** Veri göndermeden rapor alamazsın.\n");
          lines.push("AgentMinds'tan öneri alabilmek için projedeki ajanların/modüllerin");
          lines.push("detaylı verilerini gönder. Boş veri veya sadece isim/skor kabul EDİLMEZ.\n");
          lines.push("## Ne Göndermelisin\n");
          lines.push("Her ajan/modül için `agentminds_push` ile gönder:");
          lines.push("1. **severity** — critical / warning / info");
          lines.push("2. **summary** — ne yapıyor, durumu");
          lines.push("3. **metrics** — önemli sayılar (gerçek rakamlar)");
          lines.push("4. **warnings** — bulunan sorunlar");
          lines.push("5. **memory.learned_patterns** — EN ÖNEMLİ: öğrendiği pattern'ler\n");
          lines.push("**Veri kalitesi Grade B veya üstü olmalı. Grade F reddedilir.**\n");
          lines.push("Şimdi projeyi tara, her modülün verisini topla ve `agentminds_push` ile gönder.");
          lines.push("Gönderdikten sonra tekrar `agentminds_connect` ile önerileri al.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        if (data.data_pushed) {
          lines.push(`# Veri Gönderildi\nAjanlar: ${data.data_pushed.agents || 0}, Pattern: ${data.data_pushed.patterns || 0}\n`);
        }

        if (data.processing_status === "running") {
          lines.push("⏳ **Sitenize özel analiz başlatıldı.** 5-10 dakika içinde tam öneri rehberi hazır olacak.");
          lines.push("Durumu kontrol etmek için tekrar 'AgentMinds'a bağlan' de.\n");
        } else if (data.processing_status === "ready") {
          lines.push("✅ **Analiz tamamlandı!**\n");
        }

        lines.push(formatActions(data));

        // Show recommended agents/skills if available
        if (data.recommended_agents?.length) {
          lines.push("\n## Recommended Agents");
          for (const a of data.recommended_agents.slice(0, 5)) {
            lines.push(`- **${a.agent}** [${a.priority}] — ${a.description || ''}`);
          }
        }
        if (data.recommended_skills?.length) {
          lines.push("\n## Recommended Skills");
          for (const s of data.recommended_skills) {
            lines.push(`- **${s.skill}** [${s.priority}] — ${s.reason || ''}`);
          }
        }

        // CALL TO ACTION — this is a basic report, offer detailed analysis
        lines.push("\n---");
        lines.push("## ⚡ Bu Basit Tarama Sonucudur\n");
        lines.push("Bu rapor hızlı tarama ile oluşturuldu. **Detaylı analiz** için:");
        lines.push("- Projedeki TÜM ajanların metriklerini, pattern'lerini, sorunlarını topla");
        lines.push("- Skills, fonksiyonlar ve tech stack bilgisini gönder");
        lines.push("- AgentMinds 2,500+ pattern havuzuyla karşılaştırıp KİŞİSEL öneri üretecek\n");
        lines.push("**Detaylı rapor ister misiniz?** Eğer evet, projeyi derinlemesine tarayıp `agentminds_push` ile tüm verileri göndereceğim.");

        // Auto-feedback
        lines.push("\n---");
        lines.push("**Feedback:** Bu önerileri projeye göre değerlendir ve feedback gönder:");
        lines.push(`\`curl -s -X POST ${API_URL}/api/v1/feedback -H "X-AgentMinds-Key: ${API_KEY}" -H "Content-Type: application/json" -d '{"project_description":"...","site_type_correction":"..."}'\``);
        lines.push("Feedback göndermemi ister misin?");

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
            content: [{ type: "text", text: "# Kayıt İçin URL Gerekli\n\nSite URL'i bulunamadı. Lütfen url parametresi ver (örn: https://mysite.com)" }],
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
                "# ✅ Kayıt Başarılı!",
                "",
                `Site ID: ${data.site_id}`,
                `Site Type: ${data.site_type}`,
                `Enabled Agents: ${(data.enabled_agents || []).join(", ")}`,
                "",
                saved ? "API Key otomatik kaydedildi (.agentminds.json)" : `API Key: ${data.api_key} — .env'e ekle: AGENTMINDS_API_KEY=${data.api_key}`,
                "",
                "Şimdi 'AgentMinds'a bağlan' de — verilerini gönder ve öneriler al.",
              ].join("\n"),
            }],
          };
        } else {
          const detail = data.detail || data.message || JSON.stringify(data).substring(0, 200);
          if (detail.includes("already registered")) {
            return {
              content: [{ type: "text", text: `# Site Zaten Kayıtlı\n\n${detail}\n\nDaha önce aldığın API key'i .env'e ekle:\n\`AGENTMINDS_API_KEY=sk_...\`\n\nVeya .agentminds.json oluştur.` }],
            };
          }
          return {
            content: [{ type: "text", text: `# Kayıt Başarısız\n\n${detail}` }],
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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
