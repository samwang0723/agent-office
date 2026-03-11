#!/usr/bin/env node
"use strict";

const { spawnSync, execFileSync } = require("child_process");
const { join } = require("path");

const VERSION = require(join(__dirname, "..", "package.json")).version;

// ── Parse args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  cc-agent-office v${VERSION}

  Pixel-art dashboard for Claude Code multi-agent teams.
  Visualises agent statuses, messaging, and activity in real time.

  Usage
    $ cc-agent-office [options]

  Options
    --port, -p <number>   Port to listen on (default: 3456)
    --no-open             Don't auto-open the browser
    --help, -h            Show this help
    --version, -v         Show version
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

// ── Check for Bun ────────────────────────────────────────────────────────────
function hasBun() {
  try {
    execFileSync("bun", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

if (!hasBun()) {
  console.error("Error: Bun runtime is required to run cc-agent-office.");
  console.error("");
  console.error("  Install Bun:  curl -fsSL https://bun.sh/install | bash");
  console.error("  Or via npm:   npm install -g bun");
  console.error("");
  process.exit(1);
}

// ── Resolve port ─────────────────────────────────────────────────────────────
let port = process.env.PORT || "3456";
const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
if (portIdx !== -1 && args[portIdx + 1]) {
  port = args[portIdx + 1];
}

// ── Auto-open browser ────────────────────────────────────────────────────────
const noOpen = args.includes("--no-open");
if (!noOpen) {
  const openCmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  setTimeout(() => {
    try {
      spawnSync(openCmd, [`http://localhost:${port}`], { stdio: "ignore" });
    } catch {}
  }, 1000);
}

// ── Launch server ────────────────────────────────────────────────────────────
const serverPath = join(__dirname, "..", "dist", "server.js");
const result = spawnSync("bun", ["run", serverPath], {
  stdio: "inherit",
  env: { ...process.env, PORT: port },
});

process.exit(result.status || 0);
