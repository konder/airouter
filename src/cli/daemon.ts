import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { ensureRuntimeDir, LOG_FILE, PID_FILE } from './paths.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = resolve(__dirname, '../index.js');

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearPidFile(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

export function start(): void {
  ensureRuntimeDir();

  const existing = readPid();
  if (existing !== null) {
    if (isAlive(existing)) {
      console.log(`airouter daemon already running (pid=${existing})`);
      return;
    }
    clearPidFile();
  }

  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn('node', [SERVER_ENTRY], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env
  });

  if (typeof child.pid !== 'number') {
    console.error('Failed to spawn daemon process');
    process.exit(1);
  }

  writeFileSync(PID_FILE, String(child.pid), 'utf-8');
  child.unref();

  console.log(`airouter daemon started (pid=${child.pid})`);
  console.log(`  log:  ${LOG_FILE}`);
  console.log(`  pid:  ${PID_FILE}`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function stop(): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log('airouter daemon is not running');
    return;
  }

  if (!isAlive(pid)) {
    console.log(`airouter daemon was not running (stale pid=${pid})`);
    clearPidFile();
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to send SIGTERM to ${pid}: ${err}`);
    process.exit(1);
  }

  const exited = await waitForExit(pid, 5000);
  if (!exited) {
    console.log(`pid=${pid} did not exit in 5s, sending SIGKILL`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
    await waitForExit(pid, 2000);
  }

  clearPidFile();
  console.log(`airouter daemon stopped (pid=${pid})`);
}

export function status(): void {
  const pid = readPid();
  if (pid === null) {
    console.log('airouter daemon: stopped');
    return;
  }
  if (isAlive(pid)) {
    console.log(`airouter daemon: running (pid=${pid})`);
  } else {
    console.log(`airouter daemon: stopped (stale pid file: ${pid})`);
  }
}

export function logs(opts: { follow: boolean }): void {
  if (!existsSync(LOG_FILE)) {
    console.log(`(no log file at ${LOG_FILE})`);
    return;
  }
  const args = opts.follow ? ['-f', LOG_FILE] : [LOG_FILE];
  const child = spawn('tail', args, { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (typeof code === 'number') process.exit(code);
  });
}

export async function restart(): Promise<void> {
  await stop();
  start();
}
