import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TUI_ENTRY = resolve(__dirname, '../tui/index.js');

export function run(): void {
  const child = spawn('node', [TUI_ENTRY], { stdio: 'inherit' });
  child.on('exit', (code) => {
    process.exit(typeof code === 'number' ? code : 0);
  });
}
