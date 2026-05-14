#!/usr/bin/env node
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as daemon from './daemon.ts';
import * as tui from './tui.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printUsage(): void {
  console.log(`airouter — local AI API gateway

Usage:
  airouter daemon [start]        Start the server in the background
  airouter daemon stop           Stop the background server
  airouter daemon status         Show daemon status
  airouter daemon restart        Restart the background server
  airouter daemon logs [-f]      Print server logs (-f to follow)
  airouter tui                   Open the terminal UI
  airouter --version             Print version
  airouter --help                Print this help

Runtime files live in ~/.airouter/ (config.yaml, airouter.pid, airouter.log).`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, sub, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return;

    case '--version':
    case '-v':
      console.log(readVersion());
      return;

    case 'tui':
      tui.run();
      return;

    case 'daemon': {
      const action = sub ?? 'start';
      switch (action) {
        case 'start':
          daemon.start();
          return;
        case 'stop':
          await daemon.stop();
          return;
        case 'status':
          daemon.status();
          return;
        case 'restart':
          await daemon.restart();
          return;
        case 'logs': {
          const follow = rest.includes('-f') || rest.includes('--follow');
          daemon.logs({ follow });
          return;
        }
        default:
          console.error(`Unknown daemon subcommand: ${action}`);
          printUsage();
          process.exit(1);
      }
      return;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
