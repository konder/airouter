import { parse, stringify } from 'yaml';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { ApiKey, KeysFile } from '../types/index.ts';

const KEYS_FILE = join(homedir(), '.airouter', 'keys.yaml');
const PERSIST_INTERVAL_MS = 30_000;

class KeysManager {
  private byValue: Map<string, ApiKey> = new Map();
  private byName: Map<string, ApiKey> = new Map();
  private path: string;
  private dirty = false;

  constructor() {
    this.path = KEYS_FILE;
    this.load();
    this.ensureDefaultKey();
    setInterval(() => this.flush(), PERSIST_INTERVAL_MS).unref();
  }

  validate(value: string): ApiKey | null {
    return this.byValue.get(value) ?? null;
  }

  recordUse(value: string): void {
    const k = this.byValue.get(value);
    if (!k) return;
    k.lastUsed = new Date().toISOString();
    k.requestCount += 1;
    this.dirty = true;
  }

  list(): ApiKey[] {
    return Array.from(this.byName.values()).sort((a, b) => a.created.localeCompare(b.created));
  }

  issueKey(name: string): { ok: boolean; key?: ApiKey; message: string } {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: 'name is required' };
    if (this.byName.has(trimmed)) return { ok: false, message: `key "${trimmed}" already exists` };
    const key: ApiKey = {
      name: trimmed,
      value: this.generate(),
      created: new Date().toISOString(),
      requestCount: 0
    };
    this.byName.set(key.name, key);
    this.byValue.set(key.value, key);
    this.persist();
    return { ok: true, key, message: `key "${key.name}" issued` };
  }

  revokeKey(name: string): { ok: boolean; message: string } {
    const key = this.byName.get(name);
    if (!key) return { ok: false, message: `key "${name}" not found` };
    this.byName.delete(name);
    this.byValue.delete(key.value);
    this.persist();
    return { ok: true, message: `key "${name}" revoked` };
  }

  flush(): void {
    if (this.dirty) this.persist();
  }

  private ensureDefaultKey(): void {
    if (this.byName.size > 0) return;
    const r = this.issueKey('default');
    if (!r.ok || !r.key) return;
    console.log('[airouter] No client API keys found — issued default key:');
    console.log(`[airouter]   ${r.key.value}`);
    console.log('[airouter] Save it now. Future starts will not print it again.');
  }

  private generate(): string {
    return `air_${randomBytes(16).toString('hex')}`;
  }

  private load(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.path)) {
      writeFileSync(this.path, stringify({ keys: [] } satisfies KeysFile), 'utf-8');
      return;
    }
    const raw = readFileSync(this.path, 'utf-8');
    const parsed = (parse(raw) ?? {}) as Partial<KeysFile>;
    const keys = parsed.keys ?? [];
    for (const k of keys) {
      if (!k?.name || !k?.value) continue;
      const record: ApiKey = {
        name: k.name,
        value: k.value,
        created: k.created || new Date().toISOString(),
        lastUsed: k.lastUsed,
        requestCount: k.requestCount ?? 0
      };
      this.byName.set(record.name, record);
      this.byValue.set(record.value, record);
    }
  }

  private persist(): void {
    const file: KeysFile = { keys: this.list() };
    writeFileSync(this.path, stringify(file), 'utf-8');
    this.dirty = false;
  }
}

export const keysManager = new KeysManager();
