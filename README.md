# Agent Office

Pixel-art game UI for visualizing Claude Code multi-agent teams (TMUX teammates mode enabled is a MUST). Watch agents work in real-time, send them messages, and monitor activity — all through a retro-styled browser dashboard connected via WebSocket.

<img width="1996" height="1176" alt="Screenshot 2026-03-09 at 9 25 07 AM" src="https://github.com/user-attachments/assets/c2585758-ea5a-4063-b353-c9ab29448509" />


## Quick Start

### Prerequisites
- [Bun](https://bun.sh) runtime

### 1. Start the bridge server
```bash
make server
# → http://localhost:3456
```

### 2. Open the UI
```bash
open http://localhost:3456
```
Or open `ui/index.html` directly in a browser for offline demo mode.

### 3. Connect agents
Click **CONNECT** in the UI (default: `ws://localhost:3456`). Status dot turns green when live.

## Project Structure

```
agent-office/
├── src/
│   ├── server.ts           # Bun HTTP + WebSocket bridge server
│   ├── jsonl-scanner.ts    # Team JSONL transcript scanner
│   └── agent-client.ts     # Helper library for CC agents
├── ui/
│   ├── index.html          # Pixel-art game UI (CSS/JS inline)
│   ├── sprites/            # WebP sprite images (agent avatars, background)
│   ├── mobile.ts           # Mobile-specific logic (extracted for testability)
│   └── mobile.test.ts      # Tests for mobile logic
├── data/                   # Runtime state (gitignored, auto-created)
├── Makefile
├── AGENT_OFFICE.md         # System prompt template for agents
└── README.md
```

## Commands

```bash
make help                # Show all available commands
make server              # Start the bridge server on :3456
make server PORT=4000    # Start on a custom port
make dev                 # Start with watch mode (auto-restart on changes)
make dev PORT=5000       # Watch mode on a custom port
make lint                # Run Biome linter
make typecheck           # Run TypeScript type checking
make ci                  # Run all checks (typecheck + lint)
make clean               # Remove runtime data
```

## How Agents Integrate

Agents communicate with the bridge via HTTP or are auto-discovered via JSONL transcript scanning.

### Manual: Update state
```bash
curl -X POST http://localhost:3456/state \
  -H "Content-Type: application/json" \
  -d '{"id":"dev-1","status":"working","task":"Fixing auth bug","progress":30}'
```

### Manual: Poll inbox
```bash
curl http://localhost:3456/inbox/dev-1
```

### Manual: Send reply
```bash
curl -X POST http://localhost:3456/reply \
  -H "Content-Type: application/json" \
  -d '{"agentId":"dev-1","reply":"On it!","status":"working","task":"Auth fix","progress":10}'
```

### Auto: JSONL scanning
Start scanning a Claude Code team to auto-detect agent activity from transcript files:
```bash
curl -X POST http://localhost:3456/scan \
  -H "Content-Type: application/json" \
  -d '{"team":"my-team-name"}'
```

Or scan standalone (non-team) Claude Code sessions:
```bash
curl -X POST http://localhost:3456/scan/owner
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/state` | Get all agent states |
| `POST` | `/state` | Update agent state(s) — single or array |
| `POST` | `/message` | Send message to agent (writes inbox + tmux) |
| `GET` | `/inbox/:id` | Poll for unread messages |
| `POST` | `/inbox/:id/read` | Mark inbox as read |
| `DELETE` | `/inbox/:id` | Clear inbox |
| `POST` | `/reply` | Agent sends reply to UI |
| `GET` | `/teams` | List available teams |
| `GET` | `/teams/:name` | Team config details |
| `POST` | `/scan` | Start JSONL scanning for a team |
| `POST` | `/scan/owner` | Start scanning standalone owner sessions |
| `DELETE` | `/scan` | Stop scanning |
| `GET` | `/mode` | Current server mode (idle/team/owner) |
| `GET` | `/owner` | Discover standalone Claude Code sessions |
| `GET` | `/logs` | Recent bridge logs |
| `GET` | `/health` | Server health check |
| `GET` | `/sprites/*` | Static sprite images (WebP, cached) |
| `GET` | `/` | Serves the game UI |
| `WS` | `/` | WebSocket for real-time events |

### WebSocket Events (server → UI)
```json
{"event": "state_update",  "data": [...agents]}
{"event": "agent_reply",   "data": {"agentId": "dev-1", "reply": "..."}}
{"event": "message_sent",  "data": {"agentId": "dev-1", "message": "..."}}
{"event": "mode",          "data": {"mode": "team", "team": "my-team"}}
{"event": "teams_updated", "data": [...teams]}
```

## Agent State Schema

```typescript
{
  id: string           // "pm-1" | "arch-1" | "dev-1" | "qa-1" | "sec-1"
  role: string         // "pm" | "architect" | "dev" | "qa" | "security" | "lead" | "owner"
  name: string         // Display name
  status: string       // "working" | "thinking" | "idle" | "blocked" | "reviewing"
  task: string         // Current task description
  progress?: number    // 0-100
  model?: string       // e.g. "claude-opus-4-6"
  tokens?: number      // Tokens used
  hasTmux?: boolean    // Whether agent has a tmux pane for messaging
}
```

## Claude Code Integration

Add `AGENT_OFFICE.md` content to your CC agent's system prompt, replacing `$AGENT_ID` with the agent's actual ID (e.g. `dev-1`). The agent will then automatically update status, poll for messages, and reply through the UI.

## Configuration

Copy `.env.sample` to `.env` and adjust as needed:

```bash
cp .env.sample .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Bridge server port |
| `BRIDGE_URL` | `http://localhost:3456` | Used by `agent-client.ts` to connect to the bridge |

Port can also be overridden via Make: `make server PORT=4000`.
