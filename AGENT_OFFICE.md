# Agent Office Integration

You are part of the **Agent Office** multi-agent system. Your configuration:

- **Agent ID**: `$AGENT_ID` (set via environment variable)
- **Bridge URL**: `http://localhost:3456`

## Your Responsibilities

### 1. Announce yourself on startup
```bash
curl -s -X POST http://localhost:3456/state \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$AGENT_ID\",\"status\":\"working\",\"task\":\"Starting up\",\"progress\":0}"
```

### 2. Check your inbox regularly
After completing each subtask, poll for messages:
```bash
MESSAGES=$(curl -s http://localhost:3456/inbox/$AGENT_ID)
# If messages array is non-empty, process the first unread message
```

### 3. Update your status as you work
```bash
# Starting a task
curl -s -X POST http://localhost:3456/state \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$AGENT_ID\",\"status\":\"working\",\"task\":\"<what you are doing>\",\"progress\":25}"

# Thinking / blocked
curl -s -X POST http://localhost:3456/state \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$AGENT_ID\",\"status\":\"thinking\",\"task\":\"Analyzing options\"}"

# Done
curl -s -X POST http://localhost:3456/state \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$AGENT_ID\",\"status\":\"idle\",\"task\":\"Completed: <task name>\",\"progress\":100}"
```

### 4. Send replies back to the UI
When you receive a message from the UI, reply via:
```bash
curl -s -X POST http://localhost:3456/reply \
  -H "Content-Type: application/json" \
  -d "{
    \"agentId\": \"$AGENT_ID\",
    \"reply\": \"<your response text>\",
    \"status\": \"working\",
    \"task\": \"<what you are now doing>\",
    \"progress\": 10
  }"
```

## Agent Roles

| Agent ID   | Role       | Responsibilities                        |
|------------|------------|----------------------------------------|
| pm-1       | PM         | Planning, coordination, specs          |
| arch-1     | Architect  | System design, ADRs, diagrams          |
| dev-1      | Dev        | Implementation, PRs, code review       |
| qa-1       | QA         | Tests, quality checks, bug reports     |
| sec-1      | Security   | Audits, CVE scanning, auth review      |

## Status Codes

- `working`   — actively executing a task
- `thinking`  — analyzing, planning, deciding
- `reviewing` — reviewing code/docs/PRs
- `blocked`   — waiting on another agent or resource
- `idle`      — available for new tasks

## Rules

1. Always update status when starting/stopping a task
2. Keep `task` field concise (max 60 chars)
3. `progress` is 0–100 representing task completion
4. Check inbox at least every 30 seconds when active
5. Reply to UI messages within 1 polling cycle
