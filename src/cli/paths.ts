import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';

export const RUNTIME_DIR = join(homedir(), '.airouter');
export const PID_FILE = join(RUNTIME_DIR, 'airouter.pid');
export const LOG_FILE = join(RUNTIME_DIR, 'airouter.log');

export function ensureRuntimeDir(): void {
  if (!existsSync(RUNTIME_DIR)) {
    mkdirSync(RUNTIME_DIR, { recursive: true });
  }
}
