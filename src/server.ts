/**
 * Agent Office Bridge Server
 * Bun HTTP + WebSocket server bridging the UI ↔ Claude Code agents
 *
 * Flow:
 *   UI  --[POST /message]--> bridge --> writes inbox/{agentId}.json
 *   CC  --[reads inbox]----> processes --> writes state/agents.json
 *   bridge --[fs.watch]----> pushes state via WebSocket --> UI
 */

import { watch } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getTeamConfig,
  listTeams,
  startScanner,
  stopScanner,
} from "./jsonl-scanner";

const PORT = Number(process.env.PORT) || 3456;
const ROOT_DIR = join(import.meta.dir, "..");
const DATA_DIR = join(ROOT_DIR, "data");
const INBOX_DIR = join(DATA_DIR, "inbox");
const STATE_FILE = join(DATA_DIR, "agents.json");
const LOG_FILE = join(DATA_DIR, "bridge.log");

// ─── Ensure dirs exist ──────────────────────────────────────────────────────
for (const dir of [DATA_DIR, INBOX_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Default agents state (empty — agents are discovered via JSONL scanner) ──
const DEFAULT_STATE: AgentState[] = [];

if (!existsSync(STATE_FILE)) {
  writeFileSync(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface AgentState {
  id: string;
  role: string;
  name: string;
  status: "working" | "thinking" | "idle" | "blocked" | "reviewing";
  task: string;
  progress?: number;
  model?: string;
  tokens?: number;
  lastUpdated?: string;
}

interface InboxMessage {
  id: string;
  agentId: string;
  from: string; // "user" or agent id
  message: string;
  timestamp: string;
  read: boolean;
}

interface BridgeLog {
  timestamp: string;
  type: "message_in" | "state_update" | "agent_reply" | "error";
  agentId?: string;
  data: unknown;
}

// ─── Active team tracking ────────────────────────────────────────────────────
let activeTeamName: string | null = null;

// ─── WebSocket clients ───────────────────────────────────────────────────────
const clients = new Set<import("bun").ServerWebSocket<unknown>>();

function broadcast(event: string, data: unknown) {
  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      clients.delete(ws);
    }
  }
}

// ─── State helpers ───────────────────────────────────────────────────────────
function readState(): AgentState[] {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid state: not an array");
    return parsed;
  } catch (e) {
    // Backup corrupted file before overwriting
    const backupFile = `${STATE_FILE}.backup-${Date.now()}`;
    try {
      if (existsSync(STATE_FILE)) {
        writeFileSync(backupFile, readFileSync(STATE_FILE));
        console.error(`[STATE] Corrupted state backed up to ${backupFile}`);
      }
    } catch {}
    console.error("[STATE] Error reading state, resetting to defaults:", e);
    writeFileSync(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
    return [...DEFAULT_STATE];
  }
}

function writeState(state: AgentState[]) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function inferRole(agentId: string): string {
  const prefix = agentId.split("-")[0];
  const roleMap: Record<string, string> = {
    pm: "pm",
    arch: "architect",
    dev: "dev",
    qa: "qa",
    sec: "security",
  };
  return roleMap[prefix] || "dev";
}

function ensureAgent(
  state: AgentState[],
  agentId: string,
  fields?: Partial<AgentState>,
): number {
  const idx = state.findIndex((a) => a.id === agentId);
  if (idx >= 0) return idx;

  const role = fields?.role || inferRole(agentId);
  const newAgent: AgentState = {
    id: agentId,
    role,
    name: fields?.name || agentId,
    status: "idle",
    task: "Registered dynamically",
    progress: 0,
    lastUpdated: new Date().toISOString(),
    ...fields,
  };
  state.push(newAgent);
  console.log(`[STATE] Auto-registered new agent: ${agentId} (role: ${role})`);
  return state.length - 1;
}

function updateAgentState(agentId: string, update: Partial<AgentState>) {
  const state = readState();
  const idx = ensureAgent(state, agentId, update);
  state[idx] = {
    ...state[idx],
    ...update,
    lastUpdated: new Date().toISOString(),
  };
  writeState(state);
  broadcast("state_update", state);
  appendLog({
    timestamp: new Date().toISOString(),
    type: "state_update",
    agentId,
    data: update,
  });
}

function appendLog(entry: BridgeLog) {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    const lines = existing.split("\n").filter(Boolean);
    lines.push(line.trim());
    // Keep last 500 log lines
    writeFileSync(LOG_FILE, `${lines.slice(-500).join("\n")}\n`);
  } catch {}
}

// ─── Inbox helpers ───────────────────────────────────────────────────────────
function writeInbox(agentId: string, message: string, from = "user") {
  const msg: InboxMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    agentId,
    from,
    message,
    timestamp: new Date().toISOString(),
    read: false,
  };

  const inboxFile = join(INBOX_DIR, `${agentId}.json`);
  let inbox: InboxMessage[] = [];
  if (existsSync(inboxFile)) {
    try {
      inbox = JSON.parse(readFileSync(inboxFile, "utf8"));
    } catch {}
  }
  inbox.push(msg);
  writeFileSync(inboxFile, JSON.stringify(inbox, null, 2));

  appendLog({
    timestamp: new Date().toISOString(),
    type: "message_in",
    agentId,
    data: msg,
  });

  // Mark agent as thinking
  updateAgentState(agentId, {
    status: "thinking",
    task: `Processing: "${message.slice(0, 50)}${message.length > 50 ? "…" : ""}"`,
  });

  return msg;
}

function readInbox(agentId: string): InboxMessage[] {
  const inboxFile = join(INBOX_DIR, `${agentId}.json`);
  if (!existsSync(inboxFile)) return [];
  try {
    return JSON.parse(readFileSync(inboxFile, "utf8"));
  } catch {
    return [];
  }
}

function markInboxRead(agentId: string) {
  const inboxFile = join(INBOX_DIR, `${agentId}.json`);
  const inbox = readInbox(agentId).map((m) => ({ ...m, read: true }));
  writeFileSync(inboxFile, JSON.stringify(inbox, null, 2));
}

function clearInbox(agentId: string) {
  const inboxFile = join(INBOX_DIR, `${agentId}.json`);
  writeFileSync(inboxFile, "[]");
}

// ─── CORS headers ────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Resolve team-lead tmux pane at runtime ──────────────────────────────────
// The lead session's tmuxPaneId is empty in config. We find it by matching
// the leadSessionId process to a tmux pane via TTY.
let cachedLeadPane: string | null = null;
let cachedLeadTeam: string | null = null;

function resolveLeadPane(
  config: { leadSessionId?: string; name: string },
  member?: { agentType: string } | undefined,
): string | null {
  if (!member || member.agentType !== "team-lead") return null;
  if (!config.leadSessionId) return null;

  // Return cache if same team
  if (cachedLeadTeam === config.name && cachedLeadPane) return cachedLeadPane;

  try {
    // Find the lead process TTY by matching the session ID in process args
    const grep = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `ps aux | grep "${config.leadSessionId}" | grep -v grep | awk '{print $7}' | head -1`,
      ],
    });
    const tty = grep.stdout.toString().trim();
    if (!tty) return null;

    // Map TTY to tmux pane
    const panes = Bun.spawnSync({
      cmd: ["tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_tty}"],
    });
    const lines = panes.stdout.toString().trim().split("\n");
    for (const line of lines) {
      const [paneId, paneTty] = line.split(" ");
      if (paneTty?.endsWith(tty)) {
        cachedLeadPane = paneId;
        cachedLeadTeam = config.name;
        console.log(`[MSG] Resolved team-lead pane: ${paneId} (tty: ${tty})`);
        return paneId;
      }
    }
  } catch {}
  return null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ─── HTTP Router ─────────────────────────────────────────────────────────────
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Preflight
  if (method === "OPTIONS") return new Response(null, { headers: CORS });

  // ── GET /state ── returns all agents
  if (method === "GET" && path === "/state") {
    return json(readState());
  }

  // ── POST /state ── bulk update agents state (from Claude Code)
  if (method === "POST" && path === "/state") {
    const body = (await req.json()) as AgentState | AgentState[];
    const updates = Array.isArray(body) ? body : [body];
    const state = readState();
    for (const u of updates) {
      if (!u.id) continue;
      const idx = ensureAgent(state, u.id, u);
      state[idx] = {
        ...state[idx],
        ...u,
        lastUpdated: new Date().toISOString(),
      };
    }
    writeState(state);
    broadcast("state_update", state);
    appendLog({
      timestamp: new Date().toISOString(),
      type: "state_update",
      data: updates,
    });
    return json({ ok: true });
  }

  // ── POST /message ── send message to a specific agent via tmux
  if (method === "POST" && path === "/message") {
    const body = (await req.json()) as {
      agentId: string;
      message: string;
      from?: string;
    };
    if (!body.agentId || !body.message) {
      return json({ error: "agentId and message required" }, 400);
    }

    // Look up tmux pane ID from active team config
    let tmuxSent = false;
    if (activeTeamName) {
      const config = getTeamConfig(activeTeamName);
      if (config) {
        const member = config.members.find((m) => m.name === body.agentId);
        const paneId = member?.tmuxPaneId || resolveLeadPane(config, member);
        if (paneId) {
          try {
            // Send text as literal (-l prevents key name interpretation)
            Bun.spawnSync([
              "tmux",
              "send-keys",
              "-t",
              paneId,
              "-l",
              body.message,
            ]);
            // Send Enter separately to trigger submission
            const proc = Bun.spawnSync([
              "tmux",
              "send-keys",
              "-t",
              paneId,
              "Enter",
            ]);
            tmuxSent = proc.exitCode === 0;
            if (tmuxSent) {
              console.log(
                `[MSG] Sent to ${body.agentId} via tmux pane ${paneId}`,
              );
            } else {
              console.error(
                `[MSG] tmux send-keys failed for ${body.agentId}: exit ${proc.exitCode}`,
              );
            }
          } catch (e) {
            console.error(`[MSG] tmux error for ${body.agentId}:`, e);
          }
        } else {
          console.log(
            `[MSG] No tmux pane for ${body.agentId} — message saved to inbox only`,
          );
        }
      }
    }

    // Also write to file inbox as backup
    const msg = writeInbox(body.agentId, body.message, body.from || "user");
    broadcast("message_sent", {
      agentId: body.agentId,
      message: body.message,
      msgId: msg.id,
      tmuxSent,
    });
    return json({ ok: true, msgId: msg.id, tmuxSent });
  }

  // ── GET /inbox/:agentId ── Claude Code polls this
  if (method === "GET" && path.startsWith("/inbox/")) {
    const agentId = path.slice(7);
    const inbox = readInbox(agentId).filter((m) => !m.read);
    return json(inbox);
  }

  // ── POST /inbox/:agentId/read ── mark inbox as read
  if (method === "POST" && path.match(/^\/inbox\/[^/]+\/read$/)) {
    const agentId = path.split("/")[2];
    markInboxRead(agentId);
    return json({ ok: true });
  }

  // ── DELETE /inbox/:agentId ── clear inbox
  if (method === "DELETE" && path.startsWith("/inbox/")) {
    const agentId = path.slice(7);
    clearInbox(agentId);
    return json({ ok: true });
  }

  // ── POST /reply ── agent posts a reply back to UI
  if (method === "POST" && path === "/reply") {
    const body = (await req.json()) as {
      agentId: string;
      reply: string;
      status?: string;
      task?: string;
      progress?: number;
    };
    broadcast("agent_reply", body);
    if (body.status || body.task) {
      updateAgentState(body.agentId, {
        status: (body.status as AgentState["status"]) || "working",
        task: body.task || "",
        progress: body.progress,
      });
    }
    appendLog({
      timestamp: new Date().toISOString(),
      type: "agent_reply",
      agentId: body.agentId,
      data: body,
    });
    return json({ ok: true });
  }

  // ── GET /logs ── recent bridge logs
  if (method === "GET" && path === "/logs") {
    try {
      const raw = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
      const logs = raw
        .split("\n")
        .filter(Boolean)
        .slice(-100)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return json(logs.reverse());
    } catch {
      return json([]);
    }
  }

  // ── GET /teams ── list available teams from ~/.claude/teams/
  if (method === "GET" && path === "/teams") {
    return json(listTeams());
  }

  // ── GET /teams/:name ── get team config details
  if (method === "GET" && path.startsWith("/teams/")) {
    const teamName = path.slice(7);
    const config = getTeamConfig(teamName);
    if (!config) return json({ error: "Team not found" }, 404);
    return json({
      name: config.name,
      description: config.description,
      members: config.members.map((m) => ({
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        isActive: m.isActive,
        color: m.color,
      })),
    });
  }

  // ── POST /scan ── start team-based JSONL scanning
  if (method === "POST" && path === "/scan") {
    const body = (await req.json()) as { team?: string };
    const teamName = body.team;
    if (!teamName) {
      return json({ error: "team required" }, 400);
    }
    // Clear existing state when switching teams
    stopScanner();
    activeTeamName = teamName;
    cachedLeadPane = null;
    cachedLeadTeam = null;
    writeState([]);
    broadcast("state_update", []);

    startScanner(
      teamName,
      (agentId, update) => {
        updateAgentState(agentId, update as Partial<AgentState>);
      },
      (agentId, reply) => {
        broadcast("agent_reply", { agentId, reply });
        appendLog({
          timestamp: new Date().toISOString(),
          type: "agent_reply",
          agentId,
          data: { reply: reply.slice(0, 200) },
        });
      },
    );
    return json({ ok: true, team: teamName });
  }

  // ── DELETE /scan ── stop JSONL scanning
  if (method === "DELETE" && path === "/scan") {
    stopScanner();
    return json({ ok: true, scanning: false });
  }

  // ── GET /health ──
  if (path === "/health") {
    return json({
      ok: true,
      agents: readState().length,
      clients: clients.size,
      ts: new Date().toISOString(),
    });
  }

  // ── Serve UI ──
  if (method === "GET" && (path === "/" || path === "/ui")) {
    const uiFile = join(ROOT_DIR, "ui", "index.html");
    if (existsSync(uiFile)) {
      return new Response(Bun.file(uiFile), {
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("UI not found. Put index.html in ui/", { status: 404 });
  }

  return json({ error: "Not found" }, 404);
}

// ─── Watch state file for external changes (Claude Code writing directly) ───
let watchDebounce: ReturnType<typeof setTimeout> | null = null;
watch(STATE_FILE, () => {
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    try {
      const state = readState();
      broadcast("state_update", state);
    } catch {}
  }, 100);
});

// ─── Bun server ──────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    // Upgrade WebSocket connections
    if (req.headers.get("upgrade") === "websocket") {
      const ok = server.upgrade(req);
      if (ok) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return handleRequest(req);
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      // Send current state on connect — empty if no active team
      ws.send(
        JSON.stringify({
          event: "state_update",
          data: activeTeamName ? readState() : [],
          timestamp: new Date().toISOString(),
        }),
      );
      console.log(`[WS] Client connected (${clients.size} total)`);
    },
    close(ws) {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} remaining)`);
    },
    message(ws, msg) {
      // Handle pings from UI
      try {
        const data = JSON.parse(String(msg));
        if (data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch {}
    },
  },
});

console.log(`
╔═══════════════════════════════════════╗
║  Agent Office Bridge Server           ║
║  http://localhost:${PORT}                ║
║  ws://localhost:${PORT}                  ║
╠═══════════════════════════════════════╣
║  GET  /teams           → list teams   ║
║  GET  /teams/:name     → team details ║
║  POST /scan            → scan team    ║
║  GET  /state           → all agents   ║
║  POST /state           → update state ║
║  POST /message         → msg to agent ║
║  GET  /inbox/:id       → agent polls  ║
║  POST /reply           → agent reply  ║
║  GET  /logs            → bridge logs  ║
║  GET  /health          → status       ║
╚═══════════════════════════════════════╝
`);
