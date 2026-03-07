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
import { homedir } from "node:os";
import { join } from "node:path";
import {
  discoverOwnerSessions,
  getOwnerPane,
  getTeamConfig,
  listTeams,
  startOwnerScanner,
  startScanner,
  stopOwnerScanner,
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
  hasTmux?: boolean;
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

// ─── Centralized Mode State Machine ──────────────────────────────────────────
type ServerMode =
  | { type: "idle" }
  | { type: "team"; name: string }
  | { type: "owner" };

let currentMode: ServerMode = { type: "idle" };

// Convenience getter for backwards compat
function getActiveTeamName(): string | null {
  return currentMode.type === "team" ? currentMode.name : null;
}

/** Single function that handles ALL mode transitions */
function transitionTo(newMode: ServerMode) {
  const prev = currentMode;
  const isSameMode =
    prev.type === newMode.type &&
    (prev.type !== "team" ||
      (newMode.type === "team" && prev.name === newMode.name));

  if (isSameMode) return;

  console.log(
    `[MODE] ${prev.type}${prev.type === "team" ? `(${prev.name})` : ""} → ${newMode.type}${newMode.type === "team" ? `(${newMode.name})` : ""}`,
  );

  // Stop whatever is currently running
  stopScanner();
  stopOwnerScanner();
  cachedLeadPane = null;
  cachedLeadTeam = null;

  currentMode = newMode;

  if (newMode.type === "team") {
    writeState([]);
    broadcast("state_update", []);
    startScanner(
      newMode.name,
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
  } else if (newMode.type === "owner") {
    writeState([]);
    broadcast("state_update", []);
    const sessions = discoverOwnerSessions();
    if (sessions.length > 0) {
      startOwnerScanner(
        sessions,
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
    }
  } else {
    // idle
    writeState([]);
    broadcast("state_update", []);
  }

  broadcast("mode", {
    mode: newMode.type,
    team: newMode.type === "team" ? newMode.name : null,
  });
}

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
  internalWrite = true;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // Reset after a tick so the fs.watch event (fired async) sees the flag
  setTimeout(() => {
    internalWrite = false;
  }, 50);
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

  // Handle agent removal (teammate dismissed)
  if (update.task === "__removed__") {
    const filtered = state.filter((a) => a.id !== agentId);
    console.log(`[STATE] Removed dismissed agent: ${agentId}`);
    writeState(filtered);
    broadcast("state_update", filtered);
    return;
  }

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
// The lead's tmuxPaneId is empty in config. We find it by:
// 1. Using --parent-session-id from teammate processes to verify the correct team
// 2. Finding the bare `claude` process (no --agent-id) in the same tmux session
// 3. Preferring the pane closest to (but created before) the teammate panes
// This supports multiple teams running in parallel.
let cachedLeadPane: string | null = null;
let cachedLeadTeam: string | null = null;

function paneIdNum(paneId: string): number {
  return Number.parseInt(paneId.replace("%", ""), 10);
}

function resolveLeadPane(
  config: {
    leadSessionId?: string;
    members: { tmuxPaneId?: string; agentType: string }[];
    name: string;
  },
  member?: { agentType: string } | undefined,
): string | null {
  if (!member || member.agentType !== "team-lead") return null;

  // Return cache if same team and pane still exists
  if (cachedLeadTeam === config.name && cachedLeadPane) {
    const check = Bun.spawnSync({
      cmd: ["tmux", "display-message", "-t", cachedLeadPane, "-p", ""],
    });
    if (check.exitCode === 0) return cachedLeadPane;
    cachedLeadPane = null;
    cachedLeadTeam = null;
  }

  try {
    // Collect known teammate pane IDs (non-lead members with assigned panes)
    const teammatePanes = new Set(
      config.members
        .filter((m) => m.tmuxPaneId && m.agentType !== "team-lead")
        .map((m) => m.tmuxPaneId),
    );

    if (teammatePanes.size === 0) return null;

    // Verify at least one teammate process has matching --parent-session-id
    // This confirms the team config is still valid
    if (config.leadSessionId) {
      const verify = Bun.spawnSync({
        cmd: [
          "bash",
          "-c",
          `pgrep -f "parent-session-id.*${config.leadSessionId}" | head -1`,
        ],
      });
      if (!verify.stdout.toString().trim()) return null;
    }

    // Find the tmux session containing the teammates
    const samplePaneId = [...teammatePanes][0] ?? "";
    const sessionResult = Bun.spawnSync({
      cmd: [
        "tmux",
        "display-message",
        "-t",
        samplePaneId,
        "-p",
        "#{session_name}",
      ],
    });
    const teamSession = sessionResult.stdout.toString().trim();
    if (!teamSession) return null;

    // The lead pane was created BEFORE teammate panes (TeamCreate spawns after)
    const minTeammatePaneNum = Math.min(
      ...[...teammatePanes].map((p) => paneIdNum(p ?? "")),
    );

    // List all panes in that session (across all windows)
    const panesResult = Bun.spawnSync({
      cmd: [
        "tmux",
        "list-panes",
        "-s",
        "-t",
        teamSession,
        "-F",
        "#{pane_id} #{pane_tty}",
      ],
    });
    const lines = panesResult.stdout.toString().trim().split("\n");

    // Find the bare claude pane with the highest ID still before teammate panes
    let bestPaneId: string | null = null;
    let bestPaneNum = -1;

    for (const line of lines) {
      const [paneId, paneTty] = line.split(" ");
      if (!paneId || !paneTty || teammatePanes.has(paneId)) continue;

      const num = paneIdNum(paneId);
      if (num >= minTeammatePaneNum) continue;
      if (num <= bestPaneNum) continue;

      // Check if this pane runs a bare claude process (no --agent-id flag)
      const ttyShort = paneTty.replace("/dev/tty", "");
      const check = Bun.spawnSync({
        cmd: [
          "bash",
          "-c",
          `ps -t ${ttyShort} -o command= 2>/dev/null | grep -q "claude" && ! ps -t ${ttyShort} -o command= 2>/dev/null | grep "claude" | grep -q "\\-\\-agent-id"`,
        ],
      });
      if (check.exitCode === 0) {
        bestPaneId = paneId;
        bestPaneNum = num;
      }
    }

    if (bestPaneId) {
      cachedLeadPane = bestPaneId;
      cachedLeadTeam = config.name;
      console.log(
        `[MSG] Resolved team-lead pane: ${bestPaneId} (closest before teammate panes)`,
      );
      return bestPaneId;
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

  // ── GET /mode ── returns current server mode
  if (method === "GET" && path === "/mode") {
    return json({
      mode: currentMode.type,
      team: currentMode.type === "team" ? currentMode.name : null,
      state: readState(),
    });
  }

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

    // Look up tmux pane ID from active team config or owner sessions
    let tmuxSent = false;
    let paneId: string | null = null;
    const activeTeamName = getActiveTeamName();

    if (activeTeamName) {
      const config = getTeamConfig(activeTeamName);
      if (config) {
        const member = config.members.find((m) => m.name === body.agentId);
        paneId = member?.tmuxPaneId || resolveLeadPane(config, member);
      }
    } else {
      // Check owner session panes
      paneId = getOwnerPane(body.agentId);
    }

    if (paneId) {
      try {
        // Send text as literal (-l prevents key name interpretation)
        Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", body.message]);
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
          console.log(`[MSG] Sent to ${body.agentId} via tmux pane ${paneId}`);
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

  // ── GET /owner ── discover standalone Claude Code sessions
  if (method === "GET" && path === "/owner") {
    const sessions = discoverOwnerSessions();
    return json(sessions);
  }

  // ── POST /scan/owner ── start scanning owner sessions (no team)
  if (method === "POST" && path === "/scan/owner") {
    // If already in owner mode, return current state
    if (currentMode.type === "owner") {
      return json({
        ok: true,
        sessions: readState().length,
        state: readState(),
      });
    }
    transitionTo({ type: "owner" });
    return json({ ok: true, sessions: readState().length });
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

    // If already scanning this team, return current state without restarting
    if (currentMode.type === "team" && currentMode.name === teamName) {
      const state = readState();
      return json({ ok: true, team: teamName, state });
    }

    transitionTo({ type: "team", name: teamName });
    return json({ ok: true, team: teamName });
  }

  // ── DELETE /scan ── stop JSONL scanning
  if (method === "DELETE" && path === "/scan") {
    transitionTo({ type: "idle" });
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
let internalWrite = false;

watch(STATE_FILE, () => {
  if (internalWrite) return;
  if (watchDebounce) clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => {
    watchDebounce = null;
    try {
      const state = readState();
      broadcast("state_update", state);
    } catch {}
  }, 100);
});

// ─── Watch ~/.claude/teams/ for new teams ─────────────────────────────────────
const TEAMS_DIR = join(homedir(), ".claude", "teams");
let teamsWatchDebounce: ReturnType<typeof setTimeout> | null = null;
let lastKnownTeams = JSON.stringify(listTeams());

function checkForTeamChanges() {
  const current = JSON.stringify(listTeams());
  if (current !== lastKnownTeams) {
    lastKnownTeams = current;
    const teams = listTeams();
    broadcast("teams_updated", teams);
    console.log(
      `[TEAMS] Team list changed — ${teams.length} active team(s): ${teams.map((t) => t.name).join(", ") || "none"}`,
    );

    const activeTeamName = getActiveTeamName();

    // Auto-transition if the active team was dismissed
    if (activeTeamName && !teams.find((t) => t.name === activeTeamName)) {
      console.log(`[TEAMS] Active team "${activeTeamName}" is no longer alive`);
      if (teams.length > 0) {
        // Switch to the most recent remaining team
        transitionTo({ type: "team", name: teams[teams.length - 1].name });
      } else {
        // No teams remain — fall back to owner
        transitionTo({ type: "owner" });
      }
    }

    // If idle and teams appeared, auto-select the newest
    if (currentMode.type === "idle" && teams.length > 0) {
      transitionTo({ type: "team", name: teams[teams.length - 1].name });
    }

    // If in owner mode and teams appeared, switch to team
    if (currentMode.type === "owner" && teams.length > 0) {
      transitionTo({ type: "team", name: teams[teams.length - 1].name });
    }
  }
}

if (existsSync(TEAMS_DIR)) {
  watch(TEAMS_DIR, { recursive: true }, () => {
    if (teamsWatchDebounce) clearTimeout(teamsWatchDebounce);
    teamsWatchDebounce = setTimeout(() => {
      teamsWatchDebounce = null;
      checkForTeamChanges();
    }, 500);
  });
  console.log(`[TEAMS] Watching ${TEAMS_DIR} for new teams`);
} else {
  // Poll periodically in case the directory is created later
  setInterval(() => {
    if (existsSync(TEAMS_DIR)) {
      checkForTeamChanges();
    }
  }, 5000);
  console.log("[TEAMS] ~/.claude/teams/ not found — polling every 5s");
}

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
      // Send current mode so client knows what state we're in
      ws.send(
        JSON.stringify({
          event: "mode",
          data: {
            mode: currentMode.type,
            team: currentMode.type === "team" ? currentMode.name : null,
          },
          timestamp: new Date().toISOString(),
        }),
      );
      // Send current state regardless of mode
      ws.send(
        JSON.stringify({
          event: "state_update",
          data: readState(),
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
║  GET  /owner           → owner session ║
║  POST /scan/owner      → scan owner   ║
║  GET  /teams           → list teams   ║
║  GET  /teams/:name     → team details ║
║  POST /scan            → scan team    ║
║  GET  /state           → all agents   ║
║  POST /state           → update state ║
║  POST /message         → msg to agent ║
║  GET  /inbox/:id       → agent polls  ║
║  POST /reply           → agent reply  ║
║  GET  /logs            → bridge logs  ║
║  GET  /mode            → current mode ║
║  GET  /health          → status       ║
╚═══════════════════════════════════════╝
`);

// ─── Auto-detect mode on startup ─────────────────────────────────────────────
const startupTeams = listTeams();
if (startupTeams.length > 0) {
  const latest = startupTeams[startupTeams.length - 1];
  console.log(
    `[STARTUP] Found ${startupTeams.length} team(s) — auto-selecting: ${latest.name}`,
  );
  transitionTo({ type: "team", name: latest.name });
} else {
  console.log("[STARTUP] No teams — checking for owner sessions");
  transitionTo({ type: "owner" });
}
