#!/usr/bin/env node
// Single-command entry: `cc-codex-board` (or `npx cc-codex-board`).
// Reads a config file if present, starts the local read-only dashboard.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseFlags, resolveConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const flags = parseFlags(process.argv.slice(2));

if (flags.help || flags.h) {
  process.stdout.write(`cc-codex-board — local read-only dashboard for live Claude Code & Codex windows

Usage: cc-codex-board [options]

Options:
  --port <n>            Port to listen on (default 4317)
  --config <path>       Config JSON (default ./config.json or ~/.cc-codex-board.json)
  --claude-root <dir>   Override ~/.claude
  --codex-root <dir>    Override ~/.codex
  --desktop-root <dir>  Override the Claude Desktop sessions dir (for tab titles)
  --no-git              Skip git (no branch/repo resolution)
  --no-gh               Skip gh (no PR/CI/review status)
  --summary             Opt-in AI headline via local 'claude -p' (uses your CC
                        subscription, not the API). Off by default.
  --summary-model <m>   Model for --summary (default claude-haiku-4-5)
  --open                Open the dashboard in your browser
  --help                Show this help

By default the board calls NO LLM and never writes to your files. With --summary
it shells out to your local 'claude -p' (subscription) only when a window finishes
a turn, cached per turn — opt-in.
`);
  process.exit(0);
}

function loadFileConfig(flagsConfig) {
  const candidates = [];
  if (flagsConfig) candidates.push(flagsConfig);
  candidates.push(path.resolve(process.cwd(), 'config.json'));
  candidates.push(path.join(os.homedir(), '.cc-codex-board.json'));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      process.stderr.write(`⚠ could not read config ${file}: ${err.message}\n`);
    }
  }
  return {};
}

const config = resolveConfig({
  home: os.homedir(),
  fileConfig: loadFileConfig(flags.config),
  flags,
});

const server = createServer(config);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`✖ Port ${config.port} is in use. Try --port <other>.\n`);
  } else if (err.code === 'EACCES') {
    process.stderr.write(`✖ Port ${config.port} needs elevated privileges. Try a port ≥ 1024.\n`);
  } else if (err.code === 'EINVAL') {
    process.stderr.write(`✖ Invalid port ${config.port}. Must be 1–65535.\n`);
  } else {
    process.stderr.write(`✖ Failed to start on 127.0.0.1:${config.port}: ${err.message} (${err.code || 'ERR'})\n`);
  }
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://localhost:${config.port}`;
  process.stdout.write(`cc-codex-board → ${url}\n`);
  process.stdout.write(`  claude: ${config.claudeRoot}\n  codex:  ${config.codexRoot}\n`);
  process.stdout.write(`  git=${config.git} gh=${config.gh} · local ${config.localTtlMs / 1000}s / git·gh ${config.gitTtlMs / 1000}s\n`);
  if (config.open) openBrowser(url);
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* non-fatal */
  }
}
