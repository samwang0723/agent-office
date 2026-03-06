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
  readFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readdirSync
} from "fs";
import { join } from "path";
import { homedir } from "os";

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
}

type StateCallback = (agentId: string, update: Record<string, unknown>) => void;

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
        teams.push({
          name: config.name || dir,
          description: config.description,
          memberCount: config.members?.length || 0
        });
      } catch {
        continue;
      }
    }
  } catch {}
  return teams;
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
export function startScanner(teamName: string, onStateUpdate: StateCallback) {
  const config = getTeamConfig(teamName);
  if (!config) {
    console.error(`[SCANNER] Team not found: ${teamName}`);
    return;
  }

  console.log(
    `[SCANNER] Starting for team: ${teamName} (${config.members.length} members)`
  );

  // Register all members immediately from config (authoritative source)
  for (const member of config.members) {
    const role = mapAgentType(member.agentType);
    onStateUpdate(member.name, {
      id: member.name,
      role,
      name: member.name,
      status: "idle",
      task: "Registered from team config",
      model: member.model || "unknown",
      color: member.color
    });
  }

  // Initial JSONL correlation
  correlateAndTail(config, onStateUpdate);

  // Periodic scan for new/changed JSONL sessions
  scanTimer = setInterval(() => {
    correlateAndTail(config, onStateUpdate);
  }, SCAN_INTERVAL_MS);

  // Periodic tail for live status
  tailTimer = setInterval(() => {
    for (const [, agent] of tracked) {
      readNewLines(agent, onStateUpdate);
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
function correlateAndTail(config: TeamConfig, onStateUpdate: StateCallback) {
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
            actualModel: ""
          };
          tracked.set(config.leadSessionId, agent);
          console.log(
            `[SCANNER] Linked ${leadMember.name} → lead session ${config.leadSessionId.slice(0, 8)}`
          );
          readNewLines(agent, onStateUpdate);
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
        (a) => a.agentName === identity.agentName && a.teamName === config.name
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
        actualModel: ""
      };

      tracked.set(sessionId, agent);
      console.log(
        `[SCANNER] Linked ${identity.agentName} → session ${sessionId.slice(0, 8)}`
      );

      // Read recent lines immediately to get current status
      readNewLines(agent, onStateUpdate);
    }
  }
}

function identifyAgent(
  filePath: string
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
        continue;
      }
    }
  } catch {}
  return null;
}

function readNewLines(agent: TrackedAgent, onStateUpdate: StateCallback) {
  try {
    const stat = statSync(agent.filePath);
    if (stat.size <= agent.fileOffset) return;

    const readSize = Math.min(stat.size - agent.fileOffset, 64 * 1024);
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
      } catch {
        continue;
      }
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
        contextMax: getContextMax(agent.actualModel || agent.model)
      });
    }
  } catch {}
}

function processRecord(
  agent: TrackedAgent,
  rec: Record<string, unknown>
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

    const tools = content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use"
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

    const texts = content.filter(
      (b: Record<string, unknown>) => b.type === "text"
    );
    if (texts.length > 0) {
      agent.status = "thinking";
      const text = ((texts[0] as Record<string, unknown>).text as string) || "";
      agent.task = text.slice(0, 80).replace(/\n/g, " ") || "Thinking...";
      agent.lastActiveTask = agent.task;
      return true;
    }
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
  input: Record<string, unknown>
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
      return `Messaging teammate`;
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return `Managing tasks`;
    case "TodoWrite":
      return `Updating TODO list`;
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

/** Map team config agentType to UI role */
function mapAgentType(agentType: string): string {
  const t = agentType.toLowerCase();
  if (t === "team-lead") return "lead";
  if (t === "pm") return "pm";
  if (t === "architect") return "architect";
  if (t === "dev") return "dev";
  if (t === "qa") return "qa";
  if (t === "security") return "security";
  if (t === "explore") return "dev";
  return "dev";
}
