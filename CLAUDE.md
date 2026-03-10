# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Agent Office is a pixel-art game UI for visualizing Claude Code multi-agent teams. A real-time dashboard showing agent statuses, messaging, and activity — connected via WebSocket through a Bun bridge server.

## Architecture

```
Browser UI  <──WebSocket──>  Bridge Server  <──HTTP/tmux──>  Claude Code Agents
(ui/)                        (src/)                          (curl / JSONL transcripts)
```

### Data flows

1. **UI → Agent**: `POST /message` writes to `data/inbox/{agentId}.json` + sends via tmux `send-keys` if pane is known
2. **Agent → UI**: `POST /state` or `POST /reply` updates `data/agents.json`, bridge broadcasts via WebSocket
3. **Passive scanning**: JSONL scanner (`POST /scan`) tails `~/.claude/projects/` transcript files to auto-detect agent activity without agents needing to call the bridge

### Key modules

- **`src/server.ts`** — Single Bun process: HTTP routing, WebSocket management, file-based state persistence, static file serving (`/sprites/*`), and server mode state machine (idle → team → owner transitions). No framework, no dependencies beyond Bun built-ins.
- **`src/jsonl-scanner.ts`** — Reads team configs from `~/.claude/teams/{teamName}/config.json`, correlates members to JSONL transcript files by matching `teamName`/`agentName` fields, and incrementally tails new lines for live status (tool use → "working", text output → "thinking", turn end → "idle"). Also discovers standalone owner sessions via process inspection.
- **`src/agent-client.ts`** — Helper library for CC agents to integrate with the bridge (state updates, inbox polling, reply sending).
- **`ui/index.html`** — Single self-contained HTML file with all CSS/JS inline. Auto-reconnects WebSocket on disconnect, falls back to offline demo simulation. Sprite images served from `ui/sprites/*.webp`.
- **`ui/mobile.ts`** — Extracted mobile-specific logic (breakpoint detection, display agent filtering, scroll computation) for testability.

### Server mode state machine

The bridge operates in one of three modes managed by `transitionTo()`:
- **idle** — No scanning active
- **team** — Scanning a specific Claude Code team's JSONL transcripts
- **owner** — Scanning standalone Claude Code sessions (no team)

Mode transitions automatically stop previous scanners, clear state, and start new ones. The server auto-detects mode on startup (teams present → team mode, otherwise → owner mode) and watches `~/.claude/teams/` for live changes.

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime (no other dependencies)

### Commands

```bash
make server            # Start bridge server on http://localhost:3456
make dev               # Start with watch mode (auto-restart on file changes)
make server PORT=4000  # Custom port
make lint              # Run Biome linter
make typecheck         # Run TypeScript type checking
make ci                # Run all checks (typecheck + lint)
make clean             # Remove runtime data (data/)
```

```bash
bun run lint           # Biome check (src/ + ui/*.ts)
bun run lint:fix       # Biome auto-fix
bun run typecheck      # tsc --noEmit
bun run ci             # typecheck + lint
bun test               # Run tests (bun:test)
bun test ui/mobile.test.ts  # Run a single test file
```

### Linting

- **Biome** is the linter/formatter — config in `biome.json` (2-space indent, recommended rules, organize imports)
- CI runs `bun run ci` (typecheck + lint) on every PR and push to main
- A pre-commit git hook runs `bun run ci` before every commit — **all commits must pass lint**
- Fix lint errors: `bun run lint:fix`

### Runtime Data

`data/` is auto-created and gitignored:
- `data/agents.json` — current state of all agents
- `data/inbox/{agentId}.json` — per-agent message inbox
- `data/bridge.log` — last 500 log entries

### Key Constants

- Port `3456` — default in `src/server.ts`, overridable via `PORT` env var
- `BRIDGE_URL` — env var in `src/agent-client.ts` (defaults to `http://localhost:3456`)
- JSONL scanner reads from `~/.claude/teams/` and `~/.claude/projects/`
- Sprite images served from `ui/sprites/` via `GET /sprites/*` with immutable cache headers

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/state` | All agent states |
| `POST` | `/state` | Update agent state(s) — accepts single or array |
| `POST` | `/message` | Send message to agent (writes inbox + tmux) |
| `GET` | `/inbox/:id` | Poll unread messages |
| `POST` | `/inbox/:id/read` | Mark inbox read |
| `DELETE` | `/inbox/:id` | Clear inbox |
| `POST` | `/reply` | Agent reply to UI |
| `GET` | `/teams` | List available teams from ~/.claude/teams/ |
| `GET` | `/teams/:name` | Team config details |
| `POST` | `/scan` | Start JSONL scanning for a team |
| `POST` | `/scan/owner` | Start scanning standalone owner sessions |
| `DELETE` | `/scan` | Stop scanning |
| `GET` | `/mode` | Current server mode (idle/team/owner) |
| `GET` | `/owner` | Discover standalone Claude Code sessions |
| `GET` | `/logs` | Last 100 bridge log entries |
| `GET` | `/health` | Server health |
| `GET` | `/sprites/*` | Static sprite images (WebP, immutable cache) |
| `GET` | `/` | Serves UI from ui/index.html |

WebSocket events broadcast to all connected clients: `state_update`, `agent_reply`, `message_sent`, `mode`, `teams_updated`.

# currentDate
Today's date is 2026-03-10.
