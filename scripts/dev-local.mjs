#!/usr/bin/env node
/**
 * One-command local dev loop for the whole stack: API server, web client, an
 * optional second web client that proxies a deployed instance, and the
 * Electron desktop shell pointed at the dev server.
 *
 * Usage:
 *   node scripts/dev-local.mjs start [--remote https://chat.example] [--no-desktop]
 *   node scripts/dev-local.mjs status
 *   node scripts/dev-local.mjs stop
 *
 * The flags and the ordering encode four things that are easy to get wrong by
 * hand and cost an hour each time:
 *
 *   1. The web dev server must bind 127.0.0.1 explicitly. Vite's default
 *      `localhost` bind lands on ::1 only, and on Windows that loopback refuses
 *      connections, so the shell loads a dead URL and shows a blank window.
 *   2. The desktop shell only runs the checkout's code when it loads that dev
 *      origin; pointed at a real instance it renders whatever that server
 *      deployed. `BACKSPACE_URL` is what makes the difference.
 *   3. Testing against a deployed instance (real account, real voice) needs a
 *      second web client with `BACKSPACE_DEV_API`, on a different port.
 *   4. Long-running dev processes have to be detached and logged to files, and
 *      shutting them down has to survive the helper's own exit. Pids captured by
 *      this process are useless once the shell wrapper between `pnpm` and the
 *      server exits, so `stop` rediscovers live processes by port and by
 *      repository path instead of trusting a pid file.
 *
 * State and logs live in `.dev-local/` (gitignored). The helper writes nothing
 * else: `.env` is created once, on first run, and never overwritten afterwards.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = path.join(REPO_ROOT, '.dev-local');
const STATE_FILE = path.join(WORK_DIR, 'state.json');

const LOOPBACK = '127.0.0.1';
const SERVER_PORT = 3005;
const WEB_PORT = 5173;
const REMOTE_WEB_PORT = 5174;

const LOG_FILES = {
  server: path.join(WORK_DIR, 'server.log'),
  web: path.join(WORK_DIR, 'web.log'),
  webRemote: path.join(WORK_DIR, 'web-remote.log'),
  desktop: path.join(WORK_DIR, 'desktop.log'),
};

const READY_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Platform process plumbing
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `pnpm` is not on every contributor's PATH; corepack ships with Node. */
let detectedPnpm = null;
function pnpm() {
  if (detectedPnpm) return detectedPnpm;
  // A single command string: passing an argv array with `shell: true` is what
  // Node deprecates (DEP0190).
  const probeRun = spawnSync('pnpm --version', { shell: true, stdio: 'ignore' });
  detectedPnpm = probeRun.status === 0 ? 'pnpm' : 'corepack pnpm';
  return detectedPnpm;
}

/** Kill a pid and its children. POSIX services are group leaders when possible. */
function killPid(pid) {
  if (!pid || pid === process.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

function splitPids(output) {
  return output
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** PIDs with a listening TCP socket on `port`. Empty when the tool is absent. */
function listeningPids(port) {
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.includes('LISTENING') && new RegExp(`:${port}\\s`).test(line))
      .map((line) => Number(line.trim().split(/\s+/).pop()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }
  const result = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout) return splitPids(result.stdout);
  return [];
}

/**
 * Every dev process belonging to this checkout: `node` and `electron` whose
 * command line or executable sits under the repository root. Scoped by path on
 * purpose — an installed Backspace runs from %LOCALAPPDATA% and is never a
 * candidate, and neither is anything else on the machine.
 *
 * Returns `{ pid, name }` entries; `name` is lower-case for matching.
 */
function devProcesses() {
  if (process.platform === 'win32') {
    const root = REPO_ROOT.replace(/'/g, "''");
    const script = [
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='electron.exe'\"",
      `| Where-Object { $_.CommandLine -like '*${root}*' -or $_.ExecutablePath -like '${root}*' }`,
      '| ForEach-Object { "$($_.ProcessId)|$($_.Name)" }',
    ].join(' ');
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    });
    if (result.status !== 0 || !result.stdout) return [];
    return parseProcessLines(result.stdout);
  }
  // One `ps` call: pid, command name, full command line.
  const result = spawnSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return [];
  const processes = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.includes(REPO_ROOT)) continue;
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const name = (match[2] ?? '').toLowerCase();
    if (!name.includes('node') && !name.includes('electron')) continue;
    processes.push({ pid: Number(match[1]), name });
  }
  return processes;
}

function parseProcessLines(output) {
  const processes = [];
  for (const line of output.split('\n')) {
    const [rawPid, rawName] = line.trim().split('|');
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.push({ pid, name: (rawName ?? '').toLowerCase() });
  }
  return processes;
}

/** Electron processes launched from this checkout's node_modules. */
function devShellPids() {
  return devProcesses().filter((entry) => entry.name.includes('electron')).map((entry) => entry.pid);
}

// ---------------------------------------------------------------------------
// HTTP probing
// ---------------------------------------------------------------------------

/** Resolves to null when the URL answers 2xx, otherwise a short reason. */
async function probe(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(url, label) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    const failure = await probe(url);
    if (failure === null) return;
    lastError = failure;
    await sleep(500);
  }
  throw new Error(`${label} did not answer ${url} within ${READY_TIMEOUT_MS / 1000}s (last: ${lastError})`);
}

function tailLog(name, lines = 20) {
  const file = LOG_FILES[name];
  if (!file || !existsSync(file)) return `(no log yet for ${name})`;
  const content = readFileSync(file, 'utf8').trimEnd();
  if (content === '') return `(${path.relative(REPO_ROOT, file)} is empty)`;
  return content.split('\n').slice(-lines).join('\n');
}


// ---------------------------------------------------------------------------
// State file (informational only — stop rediscovers live processes)
// ---------------------------------------------------------------------------

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// .env bootstrap
// ---------------------------------------------------------------------------

/**
 * The server refuses to boot without JWT_SECRET (min 32 chars) and reads the
 * checkout's `.env` outside the test suite. Create it on first run; afterwards
 * only repair a missing or empty secret, never touch other keys.
 */
function ensureEnvFile() {
  const envPath = path.join(REPO_ROOT, '.env');
  const secret = randomBytes(32).toString('hex');

  if (!existsSync(envPath)) {
    writeFileSync(envPath, [
      '# Local development instance, generated by scripts/dev-local.mjs.',
      '# Gitignored. Add LIVEKIT_URL/API_KEY/API_SECRET to enable voice.',
      'DOMAIN=localhost',
      `PORT=${SERVER_PORT}`,
      'HOST=0.0.0.0',
      `JWT_SECRET=${secret}`,
      'REGISTRATION_OPEN=true',
      '',
    ].join('\n'));
    return 'created';
  }

  const current = readFileSync(envPath, 'utf8');
  const emptySecret = /^JWT_SECRET=[ \t]*$/m;
  if (emptySecret.test(current)) {
    writeFileSync(envPath, current.replace(emptySecret, `JWT_SECRET=${secret}`));
    return 'filled in the empty JWT_SECRET';
  }
  if (!/^JWT_SECRET=/m.test(current)) {
    writeFileSync(envPath, `${current.trimEnd()}\nJWT_SECRET=${secret}\n`);
    return 'appended a generated JWT_SECRET';
  }
  return 'kept the existing .env';
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Start a long-running dev command detached from this script, with
 * stdout/stderr in a fresh log file. Detaching matters on Windows too: without
 * it the services die when this process's console closes.
 */
function startService(name, command, env = {}) {
  mkdirSync(WORK_DIR, { recursive: true });
  const out = openSync(LOG_FILES[name], 'w');
  try {
    const child = spawn(command, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      shell: true,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  } finally {
    // The child holds its own duplicate of the descriptor.
    closeSync(out);
  }
}

function webCommand(port) {
  return `${pnpm()} --filter @backspace/web exec vite --host ${LOOPBACK} --port ${port} --strictPort`;
}


// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const PORTS = {
  server: SERVER_PORT,
  web: WEB_PORT,
  webRemote: REMOTE_WEB_PORT,
};

async function start(options) {
  const busy = Object.entries(PORTS)
    .flatMap(([name, port]) => listeningPids(port).map((pid) => ({ name, port, pid })));
  if (busy.length > 0) {
    console.error('Something is already listening:');
    for (const entry of busy) console.error(`  ${entry.name} on :${entry.port} (pid ${entry.pid})`);
    console.error('Stop it first: node scripts/dev-local.mjs stop');
    process.exitCode = 1;
    return;
  }

  console.log(`.env: ${ensureEnvFile()}`);

  const started = [];
  const paths = {
    server: `http://${LOOPBACK}:${SERVER_PORT}/api/instance/info`,
    web: `http://${LOOPBACK}:${WEB_PORT}/`,
    webRemote: `http://${LOOPBACK}:${REMOTE_WEB_PORT}/`,
  };
  const spawnStage = async (name, command, env, label) => {
    startService(name, command, env);
    started.push(name);
    await waitForReady(paths[name], label);
    console.log(label);
  };

  try {
    await spawnStage(
      'server',
      `${pnpm()} --filter @backspace/server dev`,
      {},
      `API server  http://${LOOPBACK}:${SERVER_PORT}  ready`,
    );
    await spawnStage('web', webCommand(WEB_PORT), {}, `Web client  http://${LOOPBACK}:${WEB_PORT}  ready`);
    if (options.remote) {
      await spawnStage(
        'webRemote',
        webCommand(REMOTE_WEB_PORT),
        { BACKSPACE_DEV_API: options.remote },
        `Web remote  http://${LOOPBACK}:${REMOTE_WEB_PORT}  ready -> ${options.remote}`,
      );
    }
    if (!options.noDesktop) {
      startService('desktop', `${pnpm()} --filter @backspace/desktop dev`, {
        BACKSPACE_URL: `http://${LOOPBACK}:${WEB_PORT}`,
      });
      console.log(`Desktop     loading http://${LOOPBACK}:${WEB_PORT}`);
      // Give Electron a moment so status can report it; stop rediscovers anyway.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && devShellPids().length === 0) await sleep(500);
    }
  } catch (error) {
    console.error('');
    console.error(error instanceof Error ? error.message : String(error));
    for (const name of started) {
      for (const pid of listeningPids(PORTS[name])) killPid(pid);
      console.error(`--- ${name} log ---`);
      console.error(tailLog(name, 15));
    }
    for (const pid of devShellPids()) killPid(pid);
    console.error('Stopped every process this run started.');
    process.exitCode = 1;
    return;
  }

  writeState({ startedAt: new Date().toISOString(), remote: options.remote ?? null });
  console.log('');
  await printStatus();
  console.log(`\nLogs: ${path.relative(REPO_ROOT, WORK_DIR)}/*.log`);
  console.log('Stop everything: node scripts/dev-local.mjs stop');
}

async function printStatus() {
  const state = readState();
  const rows = [
    { label: 'API server', origin: `http://${LOOPBACK}:${SERVER_PORT}`, port: SERVER_PORT, probePath: '/api/instance/info' },
    { label: 'Web (local)', origin: `http://${LOOPBACK}:${WEB_PORT}`, port: WEB_PORT, probePath: '/' },
  ];
  if (state?.remote) {
    rows.push({
      label: 'Web (remote)',
      origin: `http://${LOOPBACK}:${REMOTE_WEB_PORT}`,
      port: REMOTE_WEB_PORT,
      probePath: '/',
    });
  }

  const shellPids = devShellPids();
  let anything = false;
  for (const row of rows) {
    const pids = listeningPids(row.port);
    if (pids.length === 0) {
      console.log(`${row.label.padEnd(15)} ${row.origin.padEnd(28)} down`);
      continue;
    }
    anything = true;
    // Generous: a cold dev server compiles on first request, and the remote
    // proxy waits on another instance.
    const failure = await probe(`${row.origin}${row.probePath}`, 8000);
    console.log(`${row.label.padEnd(15)} ${row.origin.padEnd(28)} ${failure === null ? 'up' : `listening, not answering (${failure})`} (pid ${pids.join(', ')})`);
  }
  console.log(`${'Desktop shell'.padEnd(15)} ${`http://${LOOPBACK}:${WEB_PORT}`.padEnd(28)} ${shellPids.length > 0 ? `running (${shellPids.length} processes)` : 'not running'}`);
  if (shellPids.length > 0) anything = true;
  if (state?.remote) console.log(`\nRemote target: ${state.remote}`);
  if (state) console.log(`Started: ${state.startedAt}`);
  if (!anything && !state) console.log('Not running.');
}


async function stop() {
  const shellPids = devShellPids();
  const portPids = Object.values(PORTS).flatMap((port) => listeningPids(port));
  const targets = [...new Set([...shellPids, ...portPids])];

  if (targets.length === 0) {
    rmSync(STATE_FILE, { force: true });
    console.log('Nothing to stop.');
    return;
  }

  // Shell first so the window goes away, then the servers it was pointing at.
  for (const pid of shellPids) killPid(pid);
  for (const pid of portPids) killPid(pid);
  rmSync(STATE_FILE, { force: true });

  // A watcher (tsx, pnpm) can outlive the process it spawned; sweep once more.
  const deadline = Date.now() + 10_000;
  let leftovers = [];
  while (Date.now() < deadline) {
    leftovers = Object.entries(PORTS)
      .flatMap(([name, port]) => listeningPids(port).map((pid) => ({ name, port, pid })));
    if (leftovers.length === 0 && devShellPids().length === 0) break;
    await sleep(500);
    for (const entry of leftovers) killPid(entry.pid);
  }

  if (leftovers.length > 0) {
    console.error('Still listening after the sweep:');
    for (const entry of leftovers) console.error(`  ${entry.name} on :${entry.port} (pid ${entry.pid})`);
    process.exitCode = 1;
    return;
  }
  console.log('All dev services are down.');
}

function printHelp() {
  console.log(`Local dev loop for Backspace.

Usage:
  node scripts/dev-local.mjs start [--remote https://chat.example] [--no-desktop]
  node scripts/dev-local.mjs status
  node scripts/dev-local.mjs stop

start   API server (:${SERVER_PORT}), web client (:${WEB_PORT}) and the desktop
        shell pointed at it. --remote also serves this checkout's frontend on
        :${REMOTE_WEB_PORT}, proxying /api and /ws to that instance (real data
        and voice). --no-desktop skips the Electron shell.
status  What is running, with pid and reachability.
stop    Kill every dev process of this checkout, Electron included.

Logs and state: .dev-local/`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { command: 'status', remote: null, noDesktop: false, help: false };
  let commandGiven = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-desktop') {
      options.noDesktop = true;
    } else if (arg === '--remote') {
      const value = argv[index + 1];
      if (!value || !/^https?:\/\//i.test(value)) {
        throw new Error('--remote needs an http(s) origin, e.g. --remote https://chat.example');
      }
      options.remote = value.replace(/\/+$/, '');
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === 'start' || arg === 'stop' || arg === 'status') {
      if (commandGiven) throw new Error(`Unexpected argument: ${arg} (try --help)`);
      options.command = arg;
      commandGiven = true;
    } else {
      throw new Error(`Unknown argument: ${arg} (try --help)`);
    }
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else if (options.command === 'start') {
    await start(options);
  } else if (options.command === 'stop') {
    await stop();
  } else {
    await printStatus();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

