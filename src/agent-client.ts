/**
 * Agent Office — Claude Code Integration Helper
 *
 * Include this in your CLAUDE.md or call from your CC agent scripts.
 *
 * Each Claude Code agent should:
 *   1. On start: POST /state to register itself as "working"
 *   2. In a loop: GET /inbox/:agentId for new messages
 *   3. After responding: POST /reply with result + new state
 *   4. On task change: POST /state to update progress
 */

const BRIDGE = process.env.BRIDGE_URL || "http://localhost:3456";

export type AgentRole = "pm" | "architect" | "dev" | "qa" | "security";
export type AgentStatus =
  | "working"
  | "thinking"
  | "idle"
  | "blocked"
  | "reviewing";

export interface AgentStateUpdate {
  id: string;
  role?: AgentRole;
  name?: string;
  status?: AgentStatus;
  task?: string;
  progress?: number;
  model?: string;
  tokens?: number;
}

export interface InboxMessage {
  id: string;
  agentId: string;
  from: string;
  message: string;
  timestamp: string;
  read: boolean;
}

// ─── Update your agent's state in the UI ─────────────────────────────────────
export async function updateState(update: AgentStateUpdate): Promise<void> {
  try {
    await fetch(`${BRIDGE}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
  } catch (e) {
    console.error("[AgentOffice] Failed to update state:", e);
  }
}

// ─── Poll for new messages from the UI ───────────────────────────────────────
export async function pollInbox(agentId: string): Promise<InboxMessage[]> {
  try {
    const res = await fetch(`${BRIDGE}/inbox/${agentId}`);
    if (!res.ok) return [];
    const messages: InboxMessage[] = await res.json();
    if (messages.length > 0) {
      // Mark as read
      await fetch(`${BRIDGE}/inbox/${agentId}/read`, { method: "POST" });
    }
    return messages;
  } catch {
    return [];
  }
}

// ─── Send a reply back to the UI ─────────────────────────────────────────────
export async function sendReply(
  agentId: string,
  reply: string,
  stateUpdate?: Partial<AgentStateUpdate>,
): Promise<void> {
  try {
    await fetch(`${BRIDGE}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, reply, ...stateUpdate }),
    });
  } catch (e) {
    console.error("[AgentOffice] Failed to send reply:", e);
  }
}

// ─── Main agent loop ──────────────────────────────────────────────────────────
export async function runAgentLoop(
  agentId: string,
  onMessage: (msg: InboxMessage) => Promise<void>,
  pollIntervalMs = 2000,
): Promise<void> {
  console.log(
    `[AgentOffice] Agent ${agentId} polling inbox every ${pollIntervalMs}ms`,
  );

  while (true) {
    const messages = await pollInbox(agentId);
    for (const msg of messages) {
      console.log(`[AgentOffice] ${agentId} received: ${msg.message}`);
      await onMessage(msg);
    }
    await Bun.sleep(pollIntervalMs);
  }
}

// ─── Example: how to use in a Claude Code agent ──────────────────────────────
/*
  // In your CC agent's main loop or CLAUDE.md system prompt, include:

  SYSTEM PROMPT ADDITION:
  ───────────────────────
  You are part of the Agent Office system. Your agent ID is: {AGENT_ID}

  Every time you start a task, update your status:
    curl -X POST http://localhost:3456/state \
      -H "Content-Type: application/json" \
      -d '{"id":"{AGENT_ID}","status":"working","task":"<what you are doing>","progress":0}'

  Periodically check your inbox for messages:
    curl http://localhost:3456/inbox/{AGENT_ID}

  When you receive a message, process it and reply:
    curl -X POST http://localhost:3456/reply \
      -H "Content-Type: application/json" \
      -d '{"agentId":"{AGENT_ID}","reply":"<your response>","status":"working","task":"<current task>","progress":50}'

  When you complete a task:
    curl -X POST http://localhost:3456/state \
      -H "Content-Type: application/json" \
      -d '{"id":"{AGENT_ID}","status":"idle","task":"Task complete","progress":100}'
*/
