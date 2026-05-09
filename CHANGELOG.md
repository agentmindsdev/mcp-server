# Changelog — agentminds-mcp

All notable changes to the AgentMinds MCP server will be documented
here. Format: [Keep a Changelog](https://keepachangelog.com/),
[Semantic Versioning](https://semver.org/).

Companion backend changelog:
https://github.com/agentmindsdev/agentminds/blob/main/CHANGELOG.md

---

## [1.3.3] — 2026-05-09

UX polish release closing the four P1 friction points the
2026-05-09 UAT raised on top of v1.3.2. Backwards compatible —
no API contract changes, no behaviour changes for existing
users, just better output and tighter file permissions.

### Added

- **`agentminds_register` — comprehensive save-key guidance.**
  Successful registration response now lays out three storage
  options (project file / env var / password manager), explicit
  loss-recovery flow (`hello@agentminds.dev` with site URL), and
  next-step instructions. Earlier versions just said "API key
  auto-saved to .agentminds.json" — UAT showed users had no
  backup path if that file got cleaned/lost on a fresh
  workspace.
- **`agentminds_push` — full envelope schema in the tool
  description.** A LLM client (Claude Code, Cursor, …) reading
  the tool description can now produce a valid push payload
  without consulting external docs. Includes the four-value
  severity enum (`info | warning | error | critical`), nested
  `report.metrics`, `warnings`, `recommendations`, and
  `memory.learned_patterns` shape with field-level commentary.
- **`agentminds_connect` registered-no-push — "Why push?"
  comparison.** The response now includes a 2-row table comparing
  *Registered* (10 rotational, top-50 picks) vs *Personalised*
  (unlimited, stack-matched + cross-site references). Motivates
  the next-tier upgrade with concrete payoff instead of a bare
  CTA. Schema link points at the `agentminds_push` tool
  description for the envelope.

### Security

- **`.agentminds.json` permissions tightened to `0o600` on POSIX.**
  `saveKey()` now runs `chmod 600` on the written config file so
  the API key is owner-readable only. Windows ignores the call
  (no POSIX `chmod`); the rest of the platform behaviour is
  unchanged. Failure to chmod is non-fatal — onboarding
  continues, the file is still written.

### Compatibility

- API contract: unchanged. Backend a8c23b3+ continues to be the
  required minimum.
- Existing users with `AGENTMINDS_API_KEY` env var: no observable
  change.
- Existing users with `.agentminds.json` from v1.3.2 or earlier:
  no observable change. New permissions only apply on subsequent
  writes (e.g. re-running `agentminds_register`).
- Anti-hallucination contract preserved across all surfaces.

## [1.3.2] — 2026-05-09

### Fixed (CRITICAL)

- **Push silent failure.** `agentminds_push` was sending
  `site_id: "auto"` as a literal string to backend `/sync/bulk`.
  The backend's bulk handler runs `sanitize_site_id(payload.site_id)`
  followed by `_verify_site(request, site_id)` — the verifier
  cannot match a site named "auto" against any real key, so the
  backend rejected the call. The MCP layer then printed
  `Status: ${data.status || "ok"}` — and because `data.status`
  was missing/non-ok, the fallback `"ok"` was rendered regardless.
  Net effect: users called `agentminds_push`, saw "Status: ok",
  but `has_pushed_data` never flipped, `agent_count` stayed at 0,
  and `last_report_at` remained empty. The cross-site value loop
  was broken at the final step — pushed data was never persisted.
- **Anti-hallucination violation.** The `data.status || "ok"`
  fallback hardcoded a success string regardless of backend
  response. This violated the v1.3.0 anti-hallucination contract
  (5 ALL-CAPS rules in the tool description that explicitly forbid
  fabricating success). v1.3.2 restores it: the tool now surfaces
  the actual backend response — HTTP error envelopes (`{detail:
  "..."}`), missing/non-ok status fields, and validation messages
  all render as a "Push not accepted" output instead of a fake
  "Status: ok".

### Changed

- `agentminds_push` now resolves the real `site_id` from the API
  key by calling `/api/v1/sync/me` before the bulk push. Both the
  authentication state and the canonical site_id are confirmed in
  one round-trip; the bulk POST then uses the real site_id
  (matching the backend's `_verify_site` expectation).
- Push tool output now includes the backend's `data_quality`
  feedback: grade (A-F), average_score, accepted/total ratio,
  low_quality_reports, and any flagged issues. Users see the
  real grade their data earned, not a hardcoded message.
- Failed pushes display the raw backend response (truncated to
  1.2 kB) in a fenced JSON block for diagnostics. No silent
  swallow.

### Behaviour

- **Existing v1.3.1-or-earlier users**: pushes that previously
  appeared to succeed silently were not actually persisting.
  Upgrading to 1.3.2 makes pushes work end-to-end for the first
  time. The `agentminds_connect` mode for these users will
  finally transition from `registered_no_push` to the personalised
  flow once a real push lands.
- **AGENTMINDS_API_KEY users**: zero behaviour change anywhere
  *outside* the push tool. PATH C personalised flow runs the
  identical code path as before.
- **Backend**: zero changes required. The fix is entirely client-
  side. Backend `/sync/bulk` already enforced the correct contract;
  v1.3.2 just stops violating it.

## [1.3.1] — 2026-05-09

### Fixed (CRITICAL)

- **Removed implicit auto-registration on tool calls.** Earlier
  versions silently invoked `autoRegisterIfNeeded()` from the
  central tool dispatcher before the per-tool handler ran. Result:
  the very first call to *any* authenticated tool (most commonly
  `agentminds_connect`) would create a brand-new site registration
  in the AgentMinds backend using the calling project's cwd
  basename as a placeholder name, **without user consent**. This:
  - Bypassed the v1.3.0 anonymous trial path entirely (the headline
    feature of v1.3.0 — `agentminds_connect` against
    `/api/v1/sync/trial-rules` — was unreachable).
  - Polluted backend metrics with orphan registrations
    (37 registered, only 1 substantial pusher per the 2026-05-09
    UAT).
  - Created `.agentminds.json` files in user cwd's without explicit
    consent.

### Behavior changes

- `agentminds_connect` with no API key → calls `/trial-rules`
  (anonymous mode) as documented in v1.3.0 release notes.
- `agentminds_push` with no API key → returns a clear "register
  first" message with two paths (`agentminds_register` or
  manual env-var setup).
- `agentminds_actions`, `agentminds_agent_detail`,
  `agentminds_site_overview` with no API key → return an
  "authentication required" message instead of attempting an
  authenticated call against the backend.
- `agentminds_register` is unchanged — it remains the only path
  that creates a site registration, and it requires explicit
  caller intent (the user invoked the register tool).
- `agentminds_intro` and `agentminds_status` remain public,
  unchanged.

### Compatibility

- **Existing users with `AGENTMINDS_API_KEY` set: no behaviour
  change.** The PATH C personalised flow (push history present)
  runs the identical code path as v1.3.0.
- **Existing users with a `.agentminds.json` file in cwd: no
  behaviour change.** `loadProjectKey()` continues to pick the key
  up at startup.
- Internal helper `autoRegisterIfNeeded()` is preserved (still
  callable from the explicit `agentminds_register` tool flow);
  only the dispatcher-level implicit invocation is removed.

### Backend metrics cleanup

A separate task tracks DB-side cleanup of historical orphan
registrations created by pre-v1.3.1 versions. The
`_count_active_sites()` filter on `/sync/pool-stats` already
hides them from the public counter, but they remain in the DB.

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
