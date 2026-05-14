import type { Upstream, UpstreamState, Config, FailoverConfig, TokenUsage } from '../types/index.ts';
import { getConfig, getConfigPath } from '../config/index.ts';
import { stringify } from 'yaml';
import { writeFileSync } from 'fs';

const ACTIVITY_BUCKET_SEC = 10;
const ACTIVITY_MAX_BUCKETS = 360; // 1 hour of history at 10s buckets

class UpstreamManager {
  private states: Map<string, UpstreamState> = new Map();
  private config: Config;
  private latencyHistory: Map<string, number[]> = new Map();
  // bucketTs (epoch sec, floored to BUCKET_SEC) → upstream name → {input, output}
  private activity: Map<number, Map<string, { input: number; output: number }>> = new Map();

  constructor() {
    this.config = getConfig();
    this.initializeStates();
  }

  private currentBucketKey(): number {
    return Math.floor(Date.now() / 1000 / ACTIVITY_BUCKET_SEC) * ACTIVITY_BUCKET_SEC;
  }

  private pruneActivity(): void {
    const cutoff = this.currentBucketKey() - ACTIVITY_BUCKET_SEC * ACTIVITY_MAX_BUCKETS;
    for (const k of this.activity.keys()) {
      if (k < cutoff) this.activity.delete(k);
    }
  }

  private initializeStates(): void {
    for (const upstream of this.config.upstreams) {
      this.states.set(upstream.name, {
        ...upstream,
        healthy: true,
        consecutiveFailures: 0,
        requestCount: 0,
        errorCount: 0,
        latencyMs: 0,
        avgLatencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      });
      this.latencyHistory.set(upstream.name, []);
    }
  }

  // Add a new upstream
  addUpstream(upstream: Upstream): { success: boolean; message: string } {
    if (this.states.has(upstream.name)) {
      return { success: false, message: `Upstream ${upstream.name} already exists` };
    }

    // Add to states
    this.states.set(upstream.name, {
      ...upstream,
      healthy: true,
      consecutiveFailures: 0,
      requestCount: 0,
      errorCount: 0,
      latencyMs: 0,
      avgLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    });
    this.latencyHistory.set(upstream.name, []);

    // Update config
    this.config.upstreams.push(upstream);

    return { success: true, message: `Upstream ${upstream.name} added` };
  }

  // Update an existing upstream (supports rename)
  updateUpstream(name: string, updates: Partial<Upstream>): { success: boolean; message: string } {
    const upstream = this.states.get(name);
    if (!upstream) {
      return { success: false, message: `Upstream ${name} not found` };
    }

    const newName = updates.name && updates.name !== name ? updates.name : null;

    if (newName && this.states.has(newName)) {
      return { success: false, message: `Upstream ${newName} already exists` };
    }

    const updatedState = { ...upstream, ...updates };

    if (newName) {
      this.states.delete(name);
      this.states.set(newName, updatedState);
      const history = this.latencyHistory.get(name) || [];
      this.latencyHistory.delete(name);
      this.latencyHistory.set(newName, history);
    } else {
      this.states.set(name, updatedState);
    }

    const configIndex = this.config.upstreams.findIndex(u => u.name === name);
    if (configIndex >= 0) {
      this.config.upstreams[configIndex] = { ...this.config.upstreams[configIndex], ...updates };
    }

    return { success: true, message: `Upstream ${newName || name} updated` };
  }

  // Delete an upstream
  deleteUpstream(name: string): { success: boolean; message: string } {
    if (!this.states.has(name)) {
      return { success: false, message: `Upstream ${name} not found` };
    }

    // Remove from states
    this.states.delete(name);
    this.latencyHistory.delete(name);

    // Remove from config
    this.config.upstreams = this.config.upstreams.filter(u => u.name !== name);

    return { success: true, message: `Upstream ${name} deleted` };
  }

  // Persist config to file
  persistConfig(): { success: boolean; message: string } {
    try {
      const configPath = getConfigPath();
      writeFileSync(configPath, stringify(this.config), 'utf-8');
      return { success: true, message: `Config saved to ${configPath}` };
    } catch (err) {
      return { success: false, message: `Failed to save config: ${err}` };
    }
  }

  // Get upstream config (without sensitive state data)
  getUpstreamConfig(name: string): Upstream | undefined {
    const state = this.states.get(name);
    if (state) {
      return {
        name: state.name,
        type: state.type,
        baseurl: state.baseurl,
        key: state.key,
        model: state.model,
        group: state.group,
        weight: state.weight,
        enabled: state.enabled,
        authStyle: state.authStyle
      };
    }
    return undefined;
  }

  getAllUpstreams(): UpstreamState[] {
    return Array.from(this.states.values());
  }

  getUpstream(name: string): UpstreamState | undefined {
    return this.states.get(name);
  }

  getEnabledUpstreams(): UpstreamState[] {
    const cooldown = this.getFailoverConfig().cooldownMs ?? 30000;
    const now = Date.now();
    return this.getAllUpstreams().filter(u => {
      if (!u.enabled) return false;
      if (u.healthy) return true;
      // Unhealthy but cooldown expired → allow probe
      if (u.unhealthySince && now - u.unhealthySince.getTime() >= cooldown) return true;
      return false;
    });
  }

  enableUpstream(name: string): boolean {
    const upstream = this.states.get(name);
    if (!upstream) return false;
    upstream.enabled = true;
    this.syncEnabledToConfig(name, true);
    return true;
  }

  disableUpstream(name: string): boolean {
    const upstream = this.states.get(name);
    if (!upstream) return false;
    upstream.enabled = false;
    this.syncEnabledToConfig(name, false);
    return true;
  }

  // Mirror in-memory enable/disable into the config object so that
  // /admin/config/save persists the change (and surviving daemon restart).
  private syncEnabledToConfig(name: string, enabled: boolean): void {
    const idx = this.config.upstreams.findIndex(u => u.name === name);
    if (idx >= 0) this.config.upstreams[idx].enabled = enabled;
  }

  markHealthy(name: string): void {
    const upstream = this.states.get(name);
    if (upstream) {
      upstream.healthy = true;
      upstream.lastCheck = new Date();
      upstream.consecutiveFailures = 0;
      upstream.unhealthySince = undefined;
    }
  }

  markUnhealthy(name: string): void {
    const upstream = this.states.get(name);
    if (upstream) {
      upstream.healthy = false;
      upstream.lastCheck = new Date();
      upstream.errorCount++;
      upstream.unhealthySince = new Date();
    }
  }

  // Record an upstream failure. Increments consecutive counter; flips to
  // unhealthy once it crosses the configured threshold.
  recordFailure(name: string): void {
    const upstream = this.states.get(name);
    if (!upstream) return;
    upstream.consecutiveFailures++;
    upstream.errorCount++;
    upstream.lastCheck = new Date();
    const threshold = this.getFailoverConfig().healthThreshold ?? 3;
    if (upstream.consecutiveFailures >= threshold) {
      // Reset cooldown clock on every failure past threshold so probe waits anew
      upstream.healthy = false;
      upstream.unhealthySince = new Date();
    }
  }

  // Record an upstream success. Clears failure streak and recovers health.
  recordSuccess(name: string): void {
    const upstream = this.states.get(name);
    if (!upstream) return;
    upstream.consecutiveFailures = 0;
    upstream.lastCheck = new Date();
    if (!upstream.healthy) {
      upstream.healthy = true;
      upstream.unhealthySince = undefined;
    }
  }

  recordRequest(name: string): void {
    const upstream = this.states.get(name);
    if (upstream) {
      upstream.requestCount++;
    }
  }

  recordLatency(name: string, latencyMs: number): void {
    const upstream = this.states.get(name);
    if (upstream) {
      upstream.latencyMs = latencyMs;

      // Update history
      const history = this.latencyHistory.get(name) || [];
      history.push(latencyMs);
      if (history.length > 10) {
        history.shift();
      }
      this.latencyHistory.set(name, history);

      // Calculate average
      upstream.avgLatencyMs = Math.round(history.reduce((a, b) => a + b, 0) / history.length);
    }
  }

  recordTokenUsage(name: string, usage: TokenUsage): void {
    const upstream = this.states.get(name);
    if (upstream) {
      upstream.inputTokens += usage.inputTokens;
      upstream.outputTokens += usage.outputTokens;
      upstream.totalTokens += usage.inputTokens + usage.outputTokens;
    }
    // Activity bucket (independent of upstream existence — even orphaned writes are kept)
    const bk = this.currentBucketKey();
    let bucket = this.activity.get(bk);
    if (!bucket) {
      bucket = new Map();
      this.activity.set(bk, bucket);
    }
    const cur = bucket.get(name) || { input: 0, output: 0 };
    cur.input += usage.inputTokens;
    cur.output += usage.outputTokens;
    bucket.set(name, cur);
    this.pruneActivity();
  }

  // Returns recent activity buckets sorted oldest→newest. Used by the TUI chart
  // and /admin/activity. Empty buckets are NOT included; caller fills gaps.
  getActivity(): {
    bucketSeconds: number;
    now: number;
    buckets: Array<{ ts: number; values: Record<string, { input: number; output: number }> }>;
  } {
    this.pruneActivity();
    const sortedKeys = Array.from(this.activity.keys()).sort((a, b) => a - b);
    return {
      bucketSeconds: ACTIVITY_BUCKET_SEC,
      now: Math.floor(Date.now() / 1000),
      buckets: sortedKeys.map(ts => {
        const m = this.activity.get(ts)!;
        const values: Record<string, { input: number; output: number }> = {};
        for (const [name, v] of m) values[name] = { input: v.input, output: v.output };
        return { ts, values };
      })
    };
  }

  getFailoverConfig(): FailoverConfig {
    return this.config.routing.failover;
  }

  // Measure latency by making a simple request
  async measureLatency(name: string): Promise<number> {
    const upstream = this.states.get(name);
    if (!upstream) {
      return -1;
    }

    const base = upstream.baseurl.replace(/\/v1\/?$/, '');
    const testUrl = upstream.type === 'anthropic'
      ? `${base}/v1/messages`
      : `${base}/v1/models`;

    const startTime = Date.now();

    try {
      const headers: Record<string, string> = {};
      if (upstream.type === 'anthropic') {
        headers['x-api-key'] = upstream.key;
        headers['anthropic-version'] = '2023-06-01';
        // Minimal test request
        const response = await fetch(testUrl, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: upstream.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }]
          })
        });
        const latency = Date.now() - startTime;

        if (response.ok || response.status === 400) {
          // 400 might be due to invalid request but server is reachable
          this.markHealthy(name);
          this.recordLatency(name, latency);
          return latency;
        } else {
          this.markUnhealthy(name);
          return -1;
        }
      } else {
        // OpenAI-compatible — try GET /v1/models, accept any non-5xx as reachable
        headers['Authorization'] = `Bearer ${upstream.key}`;
        const response = await fetch(testUrl, { headers });
        const latency = Date.now() - startTime;

        if (response.status < 500) {
          this.markHealthy(name);
          this.recordLatency(name, latency);
          return latency;
        } else {
          console.error(`Measure ${name}: HTTP ${response.status}`);
          this.markUnhealthy(name);
          return -1;
        }
      }
    } catch (err) {
      console.error(`Latency measurement failed for ${name}:`, err);
      this.markUnhealthy(name);
      return -1;
    }
  }

  // Measure all upstreams
  async measureAllLatencies(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    for (const upstream of this.getAllUpstreams()) {
      if (upstream.enabled) {
        results[upstream.name] = await this.measureLatency(upstream.name);
      }
    }

    return results;
  }
}

export const upstreamManager = new UpstreamManager();