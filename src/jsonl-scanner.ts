/**
 * Team-based JSONL Transcript Scanner
 * Uses ~/.claude/teams/{teamName}/config.json as the source of truth for agent lists.
 * Correlates team members to their JSONL transcript files for live status tracking.
 *
 * Flow:
 *   1. Read team config → get authoritative member list with model, role, etc.
 *   2. Derive JSONL project directory from member cwd
 *   3. Scan JSONL files to find sessions belonging to each member
 *   4. Tail new lines incrementally for live status updates
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TAIL_INTERVAL_MS = 1000;
const SCAN_INTERVAL_MS = 3000;
const TEAMS_DIR = join(homedir(), ".claude", "teams");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamConfig {
  name: string;
  description?: string;
  leadAgentId?: string;
  leadSessionId?: string;
  members: TeamMember[];
}

interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  model: string;
  isActive?: boolean;
  color?: string;
  cwd?: string;
  tmuxPaneId?: string;
  joinedAt?: number;
}

interface TrackedAgent {
  agentName: string;
  teamName: string;
  agentType: string;
  model: string;
  sessionId: string;
  filePath: string;
  fileOffset: number;
  lineBuffer: string;
  lastTool: string;
  lastActivity: number;
  status: "working" | "thinking" | "idle" | "blocked" | "reviewing";
  task: string;
  lastActiveTask: string; // Remember last working/thinking task for idle display
  color?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  lastContextUsed: number; // input tokens of last turn = current context size
  actualModel: string; // real model from JSONL (may differ from config)
  lastReplyText: string; // assistant text output to forward as chat reply
  hasTmux: boolean;
}

type StateCallback = (agentId: string, update: Record<string, unknown>) => void;
type ReplyCallback = (agentId: string, reply: string) => void;

const tracked = new Map<string, TrackedAgent>();
let scanTimer: ReturnType<typeof setInterval> | null = null;
let tailTimer: ReturnType<typeof setInterval> | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/** List all available teams from ~/.claude/teams/ */
export function listTeams(): {
  name: string;
  description?: string;
  memberCount: number;
}[] {
  if (!existsSync(TEAMS_DIR)) return [];
  const teams: { name: string; description?: string; memberCount: number }[] =
    [];
  try {
    const dirs = readdirSync(TEAMS_DIR);
    for (const dir of dirs) {
      const configPath = join(TEAMS_DIR, dir, "config.json");
      if (!existsSync(configPath)) continue;
      try {
        const config: TeamConfig = JSON.parse(readFileSync(configPath, "utf8"));
        if (!isLeadAlive(config)) continue;
        teams.push({
          name: config.name || dir,
          description: config.description,
          memberCount: config.members?.length || 0,
        });
      } catch {}
    }
  } catch {}
  return teams;
}

/** Check if a team's lead session process is still running */
function isLeadAlive(config: TeamConfig): boolean {
  if (!config.leadSessionId) return false;
  try {
    const result = Bun.spawnSync({
      cmd: ["pgrep", "-f", config.leadSessionId],
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Read team config from ~/.claude/teams/{teamName}/config.json */
export function getTeamConfig(teamName: string): TeamConfig | null {
  const configPath = join(TEAMS_DIR, teamName, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Start scanning for a specific team.
 * Reads team config for authoritative member list, then finds and tails JSONL files.
 */
export function startScanner(
  teamName: string,
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
) {
  const config = getTeamConfig(teamName);
  if (!config) {
    console.error(`[SCANNER] Team not found: ${teamName}`);
    return;
  }

  console.log(
    `[SCANNER] Starting for team: ${teamName} (${config.members.length} members)`,
  );

  // Track known member names to detect new joiners
  const knownMembers = new Set<string>();
  let initialRegistrationDone = false;

  function registerMembers(cfg: TeamConfig) {
    for (const member of cfg.members) {
      if (knownMembers.has(member.name)) continue;
      knownMembers.add(member.name);
      const role = mapAgentType(member.agentType);
      onStateUpdate(member.name, {
        id: member.name,
        role,
        name: member.name,
        status: "idle",
        task: "Registered from team config",
        model: member.model || "unknown",
        color: member.color,
      });
      if (initialRegistrationDone) {
        console.log(`[SCANNER] New member joined: ${member.name} (${role})`);
      }
    }
  }

  // Register all current members
  registerMembers(config);
  initialRegistrationDone = true;

  // Initial JSONL correlation
  correlateAndTail(config, onStateUpdate, onReply);

  // Periodic scan — re-read config to pick up new/removed members
  scanTimer = setInterval(() => {
    const freshConfig = getTeamConfig(teamName);
    if (!freshConfig) return;
    registerMembers(freshConfig);

    // Detect removed members (dismissed teammates)
    const currentNames = new Set(freshConfig.members.map((m) => m.name));
    for (const name of knownMembers) {
      if (!currentNames.has(name)) {
        knownMembers.delete(name);
        tracked.delete(name);
        console.log(`[SCANNER] Member left: ${name}`);
        onStateUpdate(name, {
          id: name,
          role: "removed",
          name,
          status: "idle",
          task: "__removed__",
        });
      }
    }

    correlateAndTail(freshConfig, onStateUpdate, onReply);
  }, SCAN_INTERVAL_MS);

  // Periodic tail for live status
  tailTimer = setInterval(() => {
    for (const [, agent] of tracked) {
      readNewLines(agent, onStateUpdate, onReply);
    }
  }, TAIL_INTERVAL_MS);
}

export function stopScanner() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (tailTimer) {
    clearInterval(tailTimer);
    tailTimer = null;
  }
  tracked.clear();
  console.log("[SCANNER] Stopped");
}

export function getTrackedAgents(): Map<string, TrackedAgent> {
  return tracked;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/** Derive the JSONL project directory from a member's cwd */
function cwdToProjectDir(cwd: string): string {
  // Claude Code stores JSONL at ~/.claude/projects/{dirName}/
  // where dirName is the cwd with all non-alphanumeric chars replaced by -
  const dirName = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(PROJECTS_DIR, dirName);
}

/** Find JSONL sessions for team members and set up tailing */
function correlateAndTail(
  config: TeamConfig,
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
) {
  // Collect unique project dirs from member cwds
  const projectDirs = new Set<string>();
  for (const member of config.members) {
    if (member.cwd) {
      projectDirs.add(cwdToProjectDir(member.cwd));
    }
  }

  // Build a name→member lookup
  const memberByName = new Map<string, TeamMember>();
  for (const member of config.members) {
    memberByName.set(member.name, member);
  }

  // Handle lead session directly via leadSessionId (no teamName/agentName in JSONL)
  if (config.leadSessionId && !tracked.has(config.leadSessionId)) {
    const leadMember = config.members.find((m) => m.agentType === "team-lead");
    if (leadMember) {
      for (const projectDir of projectDirs) {
        const leadPath = join(projectDir, `${config.leadSessionId}.jsonl`);
        if (existsSync(leadPath)) {
          const stat = statSync(leadPath);
          const agent: TrackedAgent = {
            agentName: leadMember.name,
            teamName: config.name,
            agentType: leadMember.agentType,
            model: leadMember.model,
            sessionId: config.leadSessionId,
            filePath: leadPath,
            fileOffset: Math.max(0, stat.size - 64 * 1024),
            lineBuffer: "",
            lastTool: "",
            lastActivity: Date.now(),
            status: "idle",
            task: "Lead session",
            lastActiveTask: "",
            color: leadMember.color,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            lastContextUsed: 0,
            actualModel: "",
            lastReplyText: "",
            hasTmux: true,
          };
          tracked.set(config.leadSessionId, agent);
          console.log(
            `[SCANNER] Linked ${leadMember.name} → lead session ${config.leadSessionId.slice(0, 8)}`,
          );
          readNewLines(agent, onStateUpdate, onReply);
          break;
        }
      }
    }
  }

  // Scan each project dir for JSONL files (teammates)
  for (const projectDir of projectDirs) {
    if (!existsSync(projectDir)) continue;

    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      if (tracked.has(sessionId)) continue;

      const filePath = join(projectDir, file);
      const identity = identifyAgent(filePath);
      if (!identity) continue;
      if (identity.teamName !== config.name) continue;

      // Must be a known member
      const member = memberByName.get(identity.agentName);
      if (!member) continue;

      // Check if we already track this agent name (keep newest session)
      const existingEntry = [...tracked.values()].find(
        (a) => a.agentName === identity.agentName && a.teamName === config.name,
      );
      if (existingEntry) {
        try {
          const existingStat = statSync(existingEntry.filePath);
          const newStat = statSync(filePath);
          if (newStat.mtimeMs <= existingStat.mtimeMs) continue;
          tracked.delete(existingEntry.sessionId);
        } catch {
          continue;
        }
      }

      const stat = statSync(filePath);
      const agent: TrackedAgent = {
        agentName: identity.agentName,
        teamName: config.name,
        agentType: member.agentType,
        model: member.model,
        sessionId,
        filePath,
        fileOffset: Math.max(0, stat.size - 64 * 1024),
        lineBuffer: "",
        lastTool: "",
        lastActivity: Date.now(),
        status: "idle",
        task: "Discovered from JSONL",
        lastActiveTask: "",
        color: member.color,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        lastContextUsed: 0,
        actualModel: "",
        lastReplyText: "",
        hasTmux: true,
      };

      tracked.set(sessionId, agent);
      console.log(
        `[SCANNER] Linked ${identity.agentName} → session ${sessionId.slice(0, 8)}`,
      );

      // Read recent lines immediately to get current status
      readNewLines(agent, onStateUpdate, onReply);
    }
  }
}

function identifyAgent(
  filePath: string,
): { agentName: string; teamName: string } | null {
  try {
    const stat = statSync(filePath);
    const readSize = Math.min(stat.size, 16 * 1024);
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readSize);
    const bytesRead = readSync(fd, buf, 0, readSize, 0);
    closeSync(fd);

    const text = buf.toString("utf-8", 0, bytesRead);
    const lines = text.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.teamName && rec.agentName) {
          return { agentName: rec.agentName, teamName: rec.teamName };
        }
      } catch {
        const teamMatch = line.match(/"teamName"\s*:\s*"([^"]+)"/);
        const agentMatch = line.match(/"agentName"\s*:\s*"([^"]+)"/);
        if (teamMatch && agentMatch) {
          return { agentName: agentMatch[1], teamName: teamMatch[1] };
        }
      }
    }
  } catch {}
  return null;
}

function readNewLines(
  agent: TrackedAgent,
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
) {
  try {
    const stat = statSync(agent.filePath);
    if (stat.size <= agent.fileOffset) return;

    const readSize = Math.min(stat.size - agent.fileOffset, 512 * 1024);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(agent.filePath, "r");
    readSync(fd, buf, 0, readSize, agent.fileOffset);
    closeSync(fd);
    agent.fileOffset += readSize;

    const text = agent.lineBuffer + buf.toString("utf-8");
    const lines = text.split("\n");
    agent.lineBuffer = lines.pop() || "";

    let stateChanged = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const changed = processRecord(agent, rec);
        if (changed) stateChanged = true;

        // Emit reply when assistant produces text output
        if (onReply && agent.lastReplyText) {
          onReply(agent.agentName, agent.lastReplyText);
          agent.lastReplyText = "";
        }
      } catch {}
    }

    if (stateChanged) {
      const totalTokens =
        agent.inputTokens +
        agent.outputTokens +
        agent.cacheReadTokens +
        agent.cacheCreateTokens;
      onStateUpdate(agent.agentName, {
        id: agent.agentName,
        role: mapAgentType(agent.agentType),
        name: agent.agentName,
        status: agent.status,
        task: agent.task,
        model: agent.actualModel || agent.model,
        color: agent.color,
        tokens: totalTokens > 0 ? totalTokens : undefined,
        contextUsed:
          agent.lastContextUsed > 0 ? agent.lastContextUsed : undefined,
        contextMax: getContextMax(agent.actualModel || agent.model),
        hasTmux: agent.hasTmux,
      });
    }
  } catch {}
}

function processRecord(
  agent: TrackedAgent,
  rec: Record<string, unknown>,
): boolean {
  const type = rec.type as string;
  agent.lastActivity = Date.now();

  if (type === "assistant") {
    const msg = rec.message as Record<string, unknown>;
    if (!msg) return false;

    // Extract real model from JSONL
    const msgModel = msg.model as string;
    if (msgModel) {
      agent.actualModel = msgModel;
    }

    // Extract token usage from assistant message
    const usage = msg.usage as Record<string, unknown>;
    if (usage) {
      const inputThis = (usage.input_tokens as number) || 0;
      const cacheRead = (usage.cache_read_input_tokens as number) || 0;
      const cacheCreate = (usage.cache_creation_input_tokens as number) || 0;
      const outputThis = (usage.output_tokens as number) || 0;

      agent.inputTokens += inputThis;
      agent.outputTokens += outputThis;
      agent.cacheReadTokens += cacheRead;
      agent.cacheCreateTokens += cacheCreate;

      // Last turn's total input = current context window usage
      agent.lastContextUsed = inputThis + cacheRead + cacheCreate;
    }

    const content = msg.content;
    if (!Array.isArray(content)) return false;

    // Extract text blocks first (for reply emission)
    const texts = content.filter(
      (b: Record<string, unknown>) => b.type === "text",
    );
    if (texts.length > 0) {
      const text = ((texts[0] as Record<string, unknown>).text as string) || "";
      if (text.trim()) {
        agent.lastReplyText = text;
      }
    }

    const tools = content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use",
    );
    if (tools.length > 0) {
      const toolName =
        ((tools[0] as Record<string, unknown>).name as string) || "tool";
      const input =
        ((tools[0] as Record<string, unknown>).input as Record<
          string,
          unknown
        >) || {};
      agent.lastTool = toolName;
      agent.status = "working";
      agent.task = formatToolTask(toolName, input);
      agent.lastActiveTask = agent.task;
      return true;
    }

    if (texts.length > 0) {
      const text = ((texts[0] as Record<string, unknown>).text as string) || "";
      agent.status = "thinking";
      agent.task = text.slice(0, 80).replace(/\n/g, " ") || "Thinking...";
      agent.lastActiveTask = agent.task;
      return true;
    }
  }

  // Tool results are intermediate artifacts — skip entirely.
  // Only actual assistant text blocks should appear as replies.
  if (type === "user") {
    return false;
  }

  if (type === "progress") {
    const data = rec.data as Record<string, unknown>;
    if (typeof data === "object" && data !== null) {
      const progressType = data.type as string;
      if (progressType === "bash_progress" || progressType === "mcp_progress") {
        agent.status = "working";
        return false;
      }
    }
  }

  if (type === "system") {
    const subtype = rec.subtype as string;
    if (subtype === "turn_duration" || subtype === "stop_hook_summary") {
      agent.status = "idle";
      // Keep last meaningful task instead of generic "Waiting for input"
      agent.task = agent.lastActiveTask
        ? `Idle — ${agent.lastActiveTask}`
        : "Waiting for input";
      return true;
    }
  }

  return false;
}

function formatToolTask(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Read":
      return `Reading: ${shortenPath((input.file_path as string) || "")}`;
    case "Write":
      return `Writing: ${shortenPath((input.file_path as string) || "")}`;
    case "Edit":
      return `Editing: ${shortenPath((input.file_path as string) || "")}`;
    case "Bash":
      return `Running: ${((input.command as string) || "").slice(0, 40)}`;
    case "Grep":
      return `Searching: ${((input.pattern as string) || "").slice(0, 30)}`;
    case "Glob":
      return `Finding: ${((input.pattern as string) || "").slice(0, 30)}`;
    case "Agent":
      return `Delegating: ${((input.description as string) || "").slice(0, 40)}`;
    case "SendMessage":
      return "Messaging teammate";
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return "Managing tasks";
    case "TodoWrite":
      return "Updating TODO list";
    default:
      return `Using ${toolName}`;
  }
}

function shortenPath(p: string): string {
  if (!p) return "...";
  const parts = p.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : p;
}

/** Get context window max tokens for a model */
function getContextMax(model: string): number {
  if (model.includes("haiku")) return 200000;
  if (model.includes("sonnet")) return 200000;
  if (model.includes("opus")) return 200000;
  return 200000;
}

/** Map team config agentType to UI role (keyword-based matching) */
function mapAgentType(agentType: string): string {
  const t = agentType.toLowerCase();
  if (t.includes("lead")) return "lead";
  if (t.includes("owner")) return "owner";
  if (t.includes("security")) return "security";
  if (t.includes("architect")) return "architect";
  if (t.includes("explor")) return "explorer";
  if (t.includes("qa")) return "qa";
  if (t.includes("pm")) return "pm";
  if (t.includes("dev")) return "dev";
  return "dev";
}

// ─── Owner Session Discovery ──────────────────────────────────────────────────

export interface OwnerSession {
  pid: number;
  cwd: string;
  projectName: string;
  tty: string;
  tmuxPane?: string;
  jsonlPath?: string;
}

let ownerScanTimer: ReturnType<typeof setInterval> | null = null;
let ownerTailTimer: ReturnType<typeof setInterval> | null = null;
const ownerTracked = new Map<string, TrackedAgent>();
const ownerPaneMap = new Map<string, string>(); // agentName → tmuxPaneId

/** Look up the tmux pane for an owner agent by name */
export function getOwnerPane(agentName: string): string | null {
  return ownerPaneMap.get(agentName) || null;
}

/** Build tmux tty→paneId and pid→paneId mappings */
function buildTmuxMaps(): {
  ttyMap: Map<string, string>;
  pidMap: Map<number, string>;
} {
  const ttyMap = new Map<string, string>();
  const pidMap = new Map<number, string>();
  try {
    const tmuxResult = Bun.spawnSync({
      cmd: [
        "tmux",
        "list-panes",
        "-a",
        "-F",
        "#{pane_tty} #{pane_id} #{pane_pid}",
      ],
    });
    if (tmuxResult.exitCode === 0) {
      for (const line of tmuxResult.stdout.toString().trim().split("\n")) {
        const parts = line.split(" ");
        if (parts.length >= 3) {
          const [tty, paneId, panePid] = parts;
          if (tty && paneId) ttyMap.set(tty, paneId);
          if (panePid && paneId)
            pidMap.set(Number.parseInt(panePid, 10), paneId);
        }
      }
    }
  } catch {}
  return { ttyMap, pidMap };
}

/** Walk up the process tree to find if PID is a descendant of any tmux pane */
function findTmuxPaneByAncestry(
  pid: number,
  pidMap: Map<number, string>,
): string | undefined {
  let current = pid;
  const visited = new Set<number>();
  for (let i = 0; i < 10; i++) {
    if (visited.has(current) || current <= 1) break;
    visited.add(current);
    const pane = pidMap.get(current);
    if (pane) return pane;
    // Walk to parent
    try {
      const r = Bun.spawnSync({
        cmd: ["ps", "-o", "ppid=", "-p", String(current)],
      });
      const ppid = Number.parseInt(r.stdout.toString().trim(), 10);
      if (Number.isNaN(ppid) || ppid <= 1) break;
      current = ppid;
    } catch {
      break;
    }
  }
  return undefined;
}

/** Discover standalone Claude Code sessions (not part of a team) */
export function discoverOwnerSessions(): OwnerSession[] {
  const sessions: OwnerSession[] = [];
  try {
    // Find claude processes that are NOT teammates (no --agent-id flag)
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        "ps -eo pid,tty,command | grep -E '[c]laude' | grep -v -- '--agent-id' | grep -v grep | grep -v chroma | grep -v plugins | grep -v hooks | grep -v uv | grep -v bun",
      ],
    });
    const lines = result.stdout.toString().trim().split("\n").filter(Boolean);

    // Build tmux mappings (tty-based + pid-ancestry-based)
    const { ttyMap, pidMap } = buildTmuxMaps();

    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      const ttyShort = match[2];

      // Get cwd via lsof
      let cwd = "";
      try {
        const lsofResult = Bun.spawnSync({
          cmd: ["lsof", "-p", String(pid), "-Fn"],
        });
        const lsofOut = lsofResult.stdout.toString();
        const cwdMatch = lsofOut.match(/fcwd\nn(.*)/m);
        if (cwdMatch) cwd = cwdMatch[1];
      } catch {}
      if (!cwd) continue;

      const ttyFull = ttyShort.startsWith("/dev/")
        ? ttyShort
        : `/dev/${ttyShort}`;
      const projectName = cwd.split("/").pop() || cwd;

      // Try tty match first, then fall back to pid ancestry
      const tmuxPane =
        ttyMap.get(ttyFull) || findTmuxPaneByAncestry(pid, pidMap);

      sessions.push({
        pid,
        cwd,
        projectName,
        tty: ttyFull,
        tmuxPane,
      });
    }
  } catch {}
  return sessions;
}

/** Start scanning owner (standalone) sessions for live status */
export function startOwnerScanner(
  sessions: OwnerSession[],
  onStateUpdate: StateCallback,
  onReply?: ReplyCallback,
) {
  stopOwnerScanner();

  for (const session of sessions) {
    // Find JSONL file for this session
    const projectDir = cwdToProjectDir(session.cwd);
    if (!existsSync(projectDir)) continue;

    let jsonlPath: string | null = null;
    try {
      const files = readdirSync(projectDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          name: f,
          mtime: statSync(join(projectDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // Pick the most recently modified JSONL that doesn't belong to a team
      for (const file of files) {
        const filePath = join(projectDir, file.name);
        const identity = identifyAgent(filePath);
        // Skip files that belong to a team
        if (identity?.teamName) continue;
        jsonlPath = filePath;
        break;
      }
    } catch {}

    if (!jsonlPath) continue;
    session.jsonlPath = jsonlPath;

    const sessionId = jsonlPath.split("/").pop()?.replace(".jsonl", "") || "";
    if (ownerTracked.has(sessionId)) continue;

    const agentName = `owner-${session.projectName}`;
    const stat = statSync(jsonlPath);

    // Store tmux pane mapping for message routing
    if (session.tmuxPane) {
      ownerPaneMap.set(agentName, session.tmuxPane);
    }

    // Register immediately
    onStateUpdate(agentName, {
      id: agentName,
      role: "owner",
      name: agentName,
      status: "idle",
      task: session.cwd,
      model: "unknown",
      hasTmux: !!session.tmuxPane,
    });

    const agent: TrackedAgent = {
      agentName,
      teamName: "__owner__",
      agentType: "owner",
      model: "unknown",
      sessionId,
      filePath: jsonlPath,
      fileOffset: Math.max(0, stat.size - 64 * 1024),
      lineBuffer: "",
      lastTool: "",
      lastActivity: Date.now(),
      status: "idle",
      task: session.cwd,
      lastActiveTask: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      lastContextUsed: 0,
      actualModel: "",
      lastReplyText: "",
      hasTmux: !!session.tmuxPane,
    };

    ownerTracked.set(sessionId, agent);
    console.log(
      `[SCANNER] Owner session: ${agentName} → ${sessionId.slice(0, 8)}`,
    );
    readNewLines(agent, onStateUpdate, onReply);
  }

  // Tail timer for live updates
  ownerTailTimer = setInterval(() => {
    for (const [, agent] of ownerTracked) {
      readNewLines(agent, onStateUpdate, onReply);
    }
  }, TAIL_INTERVAL_MS);

  // Periodic rescan for new/ended sessions
  ownerScanTimer = setInterval(() => {
    const current = discoverOwnerSessions();

    // Update hasTmux on already-tracked agents (fixes transient tmux detection misses)
    for (const session of current) {
      if (!session.tmuxPane) continue;
      const agentName = `owner-${session.projectName}`;
      for (const [, agent] of ownerTracked) {
        if (agent.agentName === agentName && !agent.hasTmux) {
          agent.hasTmux = true;
          ownerPaneMap.set(agentName, session.tmuxPane);
          onStateUpdate(agentName, {
            id: agentName,
            hasTmux: true,
          });
          console.log(
            `[SCANNER] Updated tmux pane for ${agentName}: ${session.tmuxPane}`,
          );
        }
      }
    }

    // Register newly discovered sessions
    for (const session of current) {
      const projectDir = cwdToProjectDir(session.cwd);
      if (!existsSync(projectDir)) continue;

      let jsonlPath: string | null = null;
      try {
        const files = readdirSync(projectDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({
            name: f,
            mtime: statSync(join(projectDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime);

        for (const file of files) {
          const filePath = join(projectDir, file.name);
          const identity = identifyAgent(filePath);
          if (identity?.teamName) continue;
          jsonlPath = filePath;
          break;
        }
      } catch {}

      if (!jsonlPath) continue;
      const sessionId = jsonlPath.split("/").pop()?.replace(".jsonl", "") || "";
      if (ownerTracked.has(sessionId)) continue;

      session.jsonlPath = jsonlPath;
      const agentName = `owner-${session.projectName}`;
      const stat = statSync(jsonlPath);

      if (session.tmuxPane) {
        ownerPaneMap.set(agentName, session.tmuxPane);
      }

      onStateUpdate(agentName, {
        id: agentName,
        role: "owner",
        name: agentName,
        status: "idle",
        task: session.cwd,
        model: "unknown",
        hasTmux: !!session.tmuxPane,
      });

      const agent: TrackedAgent = {
        agentName,
        teamName: "__owner__",
        agentType: "owner",
        model: "unknown",
        sessionId,
        filePath: jsonlPath,
        fileOffset: Math.max(0, stat.size - 64 * 1024),
        lineBuffer: "",
        lastTool: "",
        lastActivity: Date.now(),
        status: "idle",
        task: session.cwd,
        lastActiveTask: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        lastContextUsed: 0,
        actualModel: "",
        lastReplyText: "",
        hasTmux: !!session.tmuxPane,
      };

      ownerTracked.set(sessionId, agent);
      console.log(
        `[SCANNER] New owner session: ${agentName} → ${sessionId.slice(0, 8)}`,
      );
      readNewLines(agent, onStateUpdate, onReply);
    }

    // Remove tracked agents whose processes are gone
    for (const [sid, agent] of ownerTracked) {
      if (agent.agentType !== "owner") continue;
      const stillAlive = current.some((s) => {
        const pd = cwdToProjectDir(s.cwd);
        return agent.filePath.startsWith(pd);
      });
      if (!stillAlive) {
        ownerTracked.delete(sid);
        ownerPaneMap.delete(agent.agentName);
        onStateUpdate(agent.agentName, {
          id: agent.agentName,
          role: "owner",
          name: agent.agentName,
          status: "idle",
          task: "__removed__",
        });
      }
    }
  }, SCAN_INTERVAL_MS);
}

export function stopOwnerScanner() {
  if (ownerScanTimer) {
    clearInterval(ownerScanTimer);
    ownerScanTimer = null;
  }
  if (ownerTailTimer) {
    clearInterval(ownerTailTimer);
    ownerTailTimer = null;
  }
  ownerTracked.clear();
  ownerPaneMap.clear();
  console.log("[SCANNER] Owner scanner stopped");
}
