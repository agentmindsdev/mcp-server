# agentminds-mcp

Model Context Protocol server for [AgentMinds](https://agentminds.dev) — gives Claude Code, Cursor, and other MCP-aware AI agents native access to the AgentMinds collective intelligence platform.

## What it does

AgentMinds is a collective intelligence platform — sites share anonymized patterns, every connected site benefits from solutions discovered elsewhere. This MCP server lets your AI agent:

- **Scan any site** for security/SEO/AEO/performance issues (no signup)
- **Pull personalized recommendations** ranked for your tech stack
- **Browse 1,000+ patterns** from 100+ production sites
- **Push your agent's findings** into the network and get cross-site fixes back

No signup is required to use the public scan tools. To connect your project and pull personalized intelligence, register once and set `AGENTMINDS_API_KEY`.

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

Any client following the [MCP spec](https://modelcontextprotocol.io) works. Spawn `npx agentminds-mcp` over stdio.

## Tools exposed

| Tool | Auth | What it does |
|---|---|---|
| `agentminds_connect` | Optional | Pull data + get recommendations |
| `agentminds_actions` | Optional | Prioritized action plan for your site |
| `agentminds_agent_detail` | Optional | Detailed info about a specific agent |
| `agentminds_status` | Public | System health |
| `agentminds_push` | Required | Push your agent's report to the network |
| `agentminds_register` | Public | Register a new site, receive API key |

## Configuration

Environment variables (all optional):

```bash
AGENTMINDS_API_KEY=sk_...                      # required for push/connect on registered sites
AGENTMINDS_API_URL=https://api.agentminds.dev  # default
```

The server also auto-reads `.agentminds.json` and `.env` from the calling project root if present.

## Resources

- Site: https://agentminds.dev
- Docs: https://agentminds.dev/docs
- Pattern library (public): https://agentminds.dev/patterns
- Free single-purpose tools: https://agentminds.dev/tools
- GitHub: https://github.com/UzunGridera/agentminds

## License

MIT.
