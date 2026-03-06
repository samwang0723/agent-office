# Agent Office 🏢

Pixel-art game UI for Claude Code multi-agent teams. Visualize your agents,
send them messages, watch them work in real-time.

```
claude-office/
├── bridge/
│   ├── server.ts          # Bun HTTP + WebSocket bridge
│   └── agent-client.ts    # Helper for CC agents to use
├── ui/
│   └── index.html         # The game UI (open in browser)
├── .claude/
│   └── commands/
│       └── AGENT_OFFICE.md  # Add to your CC agent system prompts
└── package.json
```

## Quick Start

### 1. Start the bridge server
```bash
cd claude-office
bun run start
# → http://localhost:3456
```

### 2. Open the UI
Open `ui/index.html` in your browser directly, OR:
```bash
# The bridge also serves it at:
open http://localhost:3456/ui
```

### 3. Connect
Click **CONNECT** in the UI (default: `ws://localhost:3456`).
Status dot turns green → you're live.

---

## How Agents Integrate

Each Claude Code agent needs to:

### A. Update state (tell UI what you're doing)
```bash
curl -X POST http://localhost:3456/state \
  -H "Content-Type: application/json" \
  -d '{"id":"dev-1","status":"working","task":"Fixing auth bug","progress":30}'
```

### B. Poll inbox (check for messages from UI)
```bash
curl http://localhost:3456/inbox/dev-1
# Returns: [{id, agentId, from, message, timestamp, read}]
```

### C. Send reply (respond to UI messages)
```bash
curl -X POST http://localhost:3456/reply \
  -H "Content-Type: application/json" \
  -d '{"agentId":"dev-1","reply":"On it! Pushing a branch now.","status":"working","task":"Auth bug fix","progress":10}'
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/state` | Get all agent states |
| `POST` | `/state` | Update agent state(s) |
| `POST` | `/message` | Send message to agent (from UI) |
| `GET`  | `/inbox/:id` | Poll for unread messages |
| `POST` | `/inbox/:id/read` | Mark inbox as read |
| `DELETE` | `/inbox/:id` | Clear inbox |
| `POST` | `/reply` | Agent sends reply to UI |
| `GET`  | `/logs` | Recent bridge logs |
| `GET`  | `/health` | Server health check |
| `WS`   | `/` | WebSocket for real-time events |

### WebSocket Events (server → UI)
```json
{"event": "state_update", "data": [...agents]}
{"event": "agent_reply",  "data": {"agentId": "dev-1", "reply": "..."}}
{"event": "message_sent", "data": {"agentId": "dev-1", "message": "..."}}
```

---

## Agent State Schema

```typescript
{
  id: string           // "pm-1" | "arch-1" | "dev-1" | "qa-1" | "sec-1"
  role: string         // "pm" | "architect" | "dev" | "qa" | "security"
  name: string         // Display name
  status: string       // "working" | "thinking" | "idle" | "blocked" | "reviewing"
  task: string         // Current task description (max 60 chars)
  progress?: number    // 0–100
  model?: string       // e.g. "claude-opus-4-6"
  tokens?: number      // Tokens used
}
```

---

## Claude Code CLAUDE.md Integration

Add `AGENT_OFFICE.md` content to your CC agent's system prompt or CLAUDE.md,
replacing `$AGENT_ID` with the agent's actual ID (e.g. `dev-1`).

The agent will then automatically:
- Update its status as it works
- Poll for messages from the UI
- Reply to your messages through the UI

---

## Environment Variables

```bash
BRIDGE_URL=http://localhost:3456  # Used by agent-client.ts
PORT=3456                          # Bridge server port (hardcoded, change in server.ts)
```
