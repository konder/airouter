import { parse, stringify } from 'yaml';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { Config } from '../types/index.ts';

let config: Config | null = null;
let configPath: string;

const defaultConfig: Config = {
  server: { port: 3000, host: '127.0.0.1' },
  upstreams: [],
  routing: {
    strategy: 'load-balance',
    failover: { enabled: true, maxRetries: 2, timeout: 600000 }
  }
};

function getDefaultConfigPath(): string {
  return join(homedir(), '.airouter', 'config.yaml');
}

function ensureConfigFile(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(path)) {
    writeFileSync(path, stringify(defaultConfig), 'utf-8');
  }
}

export function loadConfig(path?: string): Config {
  configPath = path || getDefaultConfigPath();
  ensureConfigFile(configPath);

  const content = readFileSync(configPath, 'utf-8');
  config = parse(content) as Config;

  validateConfig(config);

  return config;
}

export function getConfig(): Config {
  if (!config) {
    return loadConfig();
  }
  return config;
}

export function getConfigPath(): string {
  return configPath;
}

function validateConfig(config: Config): void {
  if (!config.server?.port) {
    throw new Error('server.port is required');
  }

  if (!config.upstreams) {
    config.upstreams = [];
  }

  const names = new Set<string>();
  for (const upstream of config.upstreams) {
    if (!upstream.name) {
      throw new Error('Upstream name is required');
    }
    if (names.has(upstream.name)) {
      throw new Error(`Duplicate upstream name: ${upstream.name}`);
    }
    names.add(upstream.name);

    if (!upstream.baseurl) {
      throw new Error(`Upstream ${upstream.name}: baseurl is required`);
    }
    if (!upstream.key) {
      throw new Error(`Upstream ${upstream.name}: key is required`);
    }
    if (!upstream.model) {
      throw new Error(`Upstream ${upstream.name}: model is required (the model id this upstream binds to)`);
    }
  }

  // Validate routing rules reference existing upstreams
  if (config.routing.rules) {
    for (const rule of config.routing.rules) {
      if ((rule as any).model !== undefined) {
        throw new Error(`Routing rule for upstream "${rule.upstream}": "model" field is no longer supported (client model is ignored). Use header matching or remove the rule.`);
      }
      if (!names.has(rule.upstream)) {
        throw new Error(`Rule references unknown upstream: ${rule.upstream}`);
      }
    }
  }

  if (config.routing.strategy === 'manual' && config.routing.defaultUpstream) {
    if (!names.has(config.routing.defaultUpstream)) {
      throw new Error(`Default upstream not found: ${config.routing.defaultUpstream}`);
    }
  }

  // Validate defaultGroup matches some upstream's group (warning, not fatal,
  // since groups are optional and missing default just means strict matching).
  if (config.routing.defaultGroup) {
    const allGroups = new Set(config.upstreams.map(u => u.group).filter(Boolean));
    if (!allGroups.has(config.routing.defaultGroup)) {
      console.warn(
        `[config] routing.defaultGroup="${config.routing.defaultGroup}" doesn't match any upstream's group (${Array.from(allGroups).join(', ') || 'none'}). Requests with unknown model names will fall through to all upstreams.`
      );
    }
  }

  // Inject failover defaults
  config.routing.failover ??= { enabled: true, maxRetries: 2, timeout: 30000 };
  config.routing.failover.healthThreshold ??= 3;
  config.routing.failover.cooldownMs ??= 30000;
}