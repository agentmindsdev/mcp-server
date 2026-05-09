# agentminds-mcp

[![npm version](https://img.shields.io/npm/v/agentminds-mcp.svg)](https://www.npmjs.com/package/agentminds-mcp)
[![npm downloads](https://img.shields.io/npm/dm/agentminds-mcp.svg)](https://www.npmjs.com/package/agentminds-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![ARP 1.3.0](https://img.shields.io/badge/ARP-1.3.0-blue)](https://github.com/agentmindsdev/profile)
[![MCP-aware](https://img.shields.io/badge/MCP-stdio-green)](https://modelcontextprotocol.io)

> MCP server for [AgentMinds](https://agentminds.dev) — cross-site
> collective intelligence for production AI agents. Pull patterns
> from the network, push your agent reports, get personalised
> recommendations matched to your stack. **No signup needed for
> the trial.**

## Try it now (30 seconds, no API key)

```bash
npx agentminds-mcp
```

Then call `agentminds_connect` from any MCP-aware client. You'll
get 3 popular production-observed patterns from the network — IP-
rate-limited (3/day), no registration required.

## How it works — three tiers

| Mode | Patterns | What you give | What you get |
|---|---|---|---|
| **Anonymous trial** | 3 popular / day per IP | nothing | Top relevance-scored patterns from the public pool |
| **Registered, no push** | 10 rotational / day per site | URL + name (run `agentminds_register`) | Daily-rotated slice of the top-50 pool, seeded by your `site_id` |
| **Personalised** | unlimited | agent reports (run `agentminds_push`) | Stack-matched recommendations, cross-site references, negative evidence, reversibility labels |

The backend auto-routes between modes based on your auth + push
state. The same `agentminds_connect` call returns different content
at each tier.

## Install

### Claude Code

```bash
claude mcp add agentminds -- npx agentminds-mcp
```

Or add manually to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "agentminds": {
      "command": "npx",
      "args": ["agentminds-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agentminds": {
      "command": "npx",
      "args": ["agentminds-mcp"]
    }
  }
}
```

### Other MCP clients

Any client following the [MCP spec](https://modelcontextprotocol.io)
works. Spawn `npx agentminds-mcp` over stdio.

## Tools (8)

| Tool | Auth | What it does |
|---|---|---|
| `agentminds_intro` | None | Onboarding overview + live network stats. Call this first if unsure. |
| `agentminds_status` | None | Backend health (`/health`): up/down, last pipeline, open circuits. |
| `agentminds_connect` | Optional | Tier-aware pull: anonymous trial / registered no-push / personalised. The main value tool. |
| `agentminds_register` | None | Create a site, receive an API key. Saves to `.agentminds.json` in cwd. |
| `agentminds_push` | Required | Submit agent reports (severity, summary, metrics, warnings, learned_patterns). Returns server-graded data quality. |
| `agentminds_actions` | Required | Personalised action plan for your site. |
| `agentminds_agent_detail` | Required | Inspect a specific agent (metrics, warnings, patterns). |
| `agentminds_site_overview` | Required | Dashboard view of all your agents and their status. |

## Configuration

```bash
AGENTMINDS_API_KEY=sk_...                      # required for push + authed tools
AGENTMINDS_API_URL=https://api.agentminds.dev  # default
```

The server also auto-reads `.agentminds.json` and `.env` from the
calling project's cwd if `AGENTMINDS_API_KEY` is unset:

```json
{
  "site_id": "yoursite",
  "api_key": "sk_yoursite_...",
  "site_url": "https://yoursite.com"
}
```

## Privacy

- **Anonymous trial:** no payload sent — only your IP is used for
  the 3/day rate limit (in-memory at the backend, not logged
  per-request).
- **Registered:** the URL + name you pass to `agentminds_register`
  are stored. No telemetry beyond that.
- **Push:** agent reports you submit are stored in the pool. You
  control the content — anonymise before sending if needed. The
  backend strips site identity before reports are surfaced to
  other sites' personalised flows.
- **No analytics, no tracking.** The MCP server makes HTTP calls
  only when you explicitly invoke a tool.

## Honest status (2026-05-09)

This is early. We're inside the first 100-founder window:

| Metric | Value |
|---|---|
| Founder slots remaining | 89 / 100 |
| Contributing sites | 11 |
| Production-observed patterns | 1,896 |
| Documented patterns | 702 |
| Total tier-1 patterns | 2,598 |

The cross-site "peer sites solving the same problem" feature
activates as the network grows. Today most patterns come from the
external harvester (public GitHub issues, MCP corpora, awesome
lists) rather than peer sites — the personalised flow surfaces
them with stack-matching, but the network-effect moat is still
forming.

If you're evaluating this for your team: the
[**ARP spec**](https://github.com/agentmindsdev/profile) is the
most mature surface (formally versioned at v1.3.0, with
extension points and a [reorientation clause](https://github.com/agentmindsdev/profile#reorientation-clause)
explicitly telling readers to prefer OpenTelemetry GenAI / MCP
when those cover your need). The MCP server and SDKs are v1.3.x —
actively iterated, may have rough edges. Bug reports welcome.

## Lineage

ARP is a **profile** built on top of OpenTelemetry GenAI semantic
conventions, MCP, Sentry-style runtime ergonomics, Anthropic
Claude Skills, and AGNTCY OASF. The single primitive AgentMinds
owns is the cross-site learned-pattern lifecycle — see
[`AGENT_REPORTING_PROFILE.md`](https://github.com/agentmindsdev/profile/blob/main/AGENT_REPORTING_PROFILE.md)
§4.1.

## Resources

- **Site:** https://agentminds.dev
- **Spec (ARP v1.3.0):** https://github.com/agentmindsdev/profile
- **API base:** https://api.agentminds.dev
- **Public pool stats:** https://api.agentminds.dev/api/v1/sync/pool-stats
- **Pricing:** https://agentminds.dev/pricing
- **Issues:** https://github.com/agentmindsdev/mcp-server/issues
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)

## License

MIT.
