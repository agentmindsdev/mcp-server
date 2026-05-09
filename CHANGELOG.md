# Changelog — agentminds-mcp

All notable changes to the AgentMinds MCP server will be documented
here. Format: [Keep a Changelog](https://keepachangelog.com/),
[Semantic Versioning](https://semver.org/).

Companion backend changelog:
https://github.com/agentmindsdev/agentminds/blob/main/CHANGELOG.md

---

## [1.3.0] — 2026-05-08

### Changed (tier-aware behaviour)

- **`agentminds_connect` now works without an API key.** Three modes
  selected by auth state + push history:
  - **Anonymous** (no `AGENTMINDS_API_KEY`): hits
    `/api/v1/sync/trial-rules`. Returns 3 popular production-observed
    patterns from the network + pool stats + register CTA. Backend
    rate-limits to 3 calls/day per IP.
  - **Registered, no push** (key set, no prior `agentminds_push`):
    hits `/api/v1/sync/personalized-rules`; backend returns
    `mode=registered_no_push` with up to 10 patterns/day, daily
    rotation seeded by site_id. Push CTA in output.
  - **Pushed** (key + push history): hits
    `/api/v1/sync/personalized-rules` and renders the full ARP v1.3
    response shape — `top_production_observed`, `top_documented`,
    `negative_evidence`, reversibility labels, cross-site stats.
    Behaviour unchanged from v1.2.x for users already on this path.
- **Tool description rewritten** to explain the three modes
  explicitly, with anti-hallucination rules preserved verbatim. The
  description now tells the calling AI to distinguish
  `trial_anonymous` (popular) vs `registered_no_push` (rotational)
  vs `personalized` (stack-matched) so it never confuses one with
  another in its output.
- **New optional `limit` argument** on `agentminds_connect` (default
  10, capped at 20). Anonymous mode always returns 3 regardless.

### Backwards compatibility

- Existing authenticated push-first users see **no behavioural
  change** — the same `/personalized-rules` endpoint, same response
  shape, same anti-hallucination guards.
- API key contract unchanged. Push contract unchanged.
- `/api/v1/sync/personalized-rules` v1.3 response shape unchanged
  for pushed users.
- Backwards-compat formatter retained: if a backend deployment still
  emits only `top_rules` (pre-v1.3), the MCP renders that array as a
  fallback.

### Deprecations / removals

- The previous "no key → free scan via `/api/v1/free-scan`" path on
  `agentminds_connect` is removed. Free-scan output (security/SEO
  grade for a URL) is no longer reachable through this tool. Users
  who want a URL scan should call `/api/v1/scan` directly or wait
  for a dedicated `agentminds_scan` tool.
- The previous "no data → push first" hard-fail branch is removed
  for registered-no-push users; the backend now returns rotational
  patterns instead of an error.

### Backend support

- Requires `agentmindsdev/agentminds` commit `a8c23b3` or later.
  Earlier deployments will return 404 on `/trial-rules`.

### Funnel

Removes the push-first wall identified as the main funnel killer
(2026-05-08 analysis: 2,057 monthly npm downloads → 9 connected
sites → 1 substantial push). New users see real value on the first
MCP call; registration becomes an upgrade step rather than a
prerequisite.

---

## [1.2.4] — 2026-05-04

User-facing strings translated to English. Internal Turkish
docstrings + log lines retained. ENGLISH-ONLY hard rule documented
in companion backend repo.

## [1.2.3] — 2026-05-03

Closed the download → register conversion gap: `agentminds_intro`
now surfaces a register CTA for first-time users.

## [1.2.0–1.2.2] — 2026-04-25 → 2026-04-30

Initial public publish + welcome-banner scaffolding. See git history
for granular detail.
