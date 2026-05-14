import type { RequestFormat, UpstreamState } from '../types/index.ts';
import { upstreamManager } from './upstream.ts';
import { getConfig } from '../config/index.ts';

type RoutingStrategy = 'load-balance' | 'rules' | 'manual';

export interface RouteRequest {
  format: RequestFormat;
  model?: string;     // client-supplied model name; used to select a group
  headers?: Record<string, string>;
  exclude?: Set<string>;
}

class RequestRouter {
  // Per-upstream weighted-RR offsets. Mapping must persist across calls.
  private currentWeights: Map<string, number> = new Map();
  private strategy: RoutingStrategy;

  constructor() {
    this.strategy = getConfig().routing.strategy;
  }

  // Get next upstream based on routing strategy.
  getNextUpstream(req: RouteRequest): UpstreamState | null {
    switch (this.strategy) {
      case 'manual':
        return this.getManualUpstream(req);
      case 'rules':
        return this.getRuleBasedUpstream(req);
      case 'load-balance':
      default:
        return this.getLoadBalancedUpstream(req);
    }
  }

  // Resolve which group a request targets:
  //   1. If req.model matches some upstream's group → that group
  //   2. Else if config.routing.defaultGroup is set → that group
  //   3. Else null (no group filter — use all upstreams, legacy behavior)
  private resolveGroup(req: RouteRequest, allUpstreams: UpstreamState[]): string | null {
    const groupsInUse = new Set(allUpstreams.map(u => u.group).filter((g): g is string => !!g));
    // Models whose name contains "claude" prefer the "claude" group when present —
    // lets Claude Code clients hit Anthropic-format upstreams without per-model config.
    if (req.model && req.model.toLowerCase().includes('claude') && groupsInUse.has('claude')) {
      return 'claude';
    }
    if (req.model && groupsInUse.has(req.model)) return req.model;
    const defaultGroup = getConfig().routing.defaultGroup;
    if (defaultGroup && groupsInUse.has(defaultGroup)) return defaultGroup;
    return null;
  }

  private candidates(req: RouteRequest): UpstreamState[] {
    const all = upstreamManager.getEnabledUpstreams();
    const excluded = req.exclude ? all.filter(u => !req.exclude!.has(u.name)) : all;
    // Group filtering: if a target group is resolved, restrict to that pool.
    // If no group can be resolved (no groups configured at all, or no matches),
    // fall back to the full enabled pool — backward-compatible behavior.
    const targetGroup = this.resolveGroup(req, upstreamManager.getAllUpstreams());
    if (!targetGroup) return excluded;
    const inGroup = excluded.filter(u => u.group === targetGroup);
    return inGroup.length > 0 ? inGroup : excluded;
  }

  // Prefer same-format upstreams; if none, fall back to all candidates.
  private preferFormat(candidates: UpstreamState[], format: RequestFormat): UpstreamState[] {
    const matching = candidates.filter(u => u.type === format);
    return matching.length > 0 ? matching : candidates;
  }

  private getManualUpstream(req: RouteRequest): UpstreamState | null {
    const config = getConfig();
    const defaultName = config.routing.defaultUpstream;
    if (defaultName && !req.exclude?.has(defaultName)) {
      const upstream = upstreamManager.getUpstream(defaultName);
      if (upstream && upstream.enabled) {
        return upstream;
      }
    }
    // Fallback: any candidate, format-preferred
    const pool = this.preferFormat(this.candidates(req), req.format);
    return pool[0] || null;
  }

  private getRuleBasedUpstream(req: RouteRequest): UpstreamState | null {
    const config = getConfig();
    const rules = config.routing.rules || [];

    for (const rule of rules) {
      if (!this.matchesRule(rule, req)) continue;
      if (req.exclude?.has(rule.upstream)) continue;
      const upstream = upstreamManager.getUpstream(rule.upstream);
      if (upstream && upstream.enabled && upstream.healthy) {
        return upstream;
      }
    }

    // No rule matched (or matched upstream unavailable) → load-balance fallback
    return this.getLoadBalancedUpstream(req);
  }

  private matchesRule(
    rule: { header?: string; upstream: string },
    req: RouteRequest
  ): boolean {
    if (rule.header && req.headers) {
      const [headerName, headerValue] = rule.header.split(':').map(s => s.trim());
      const actualValue = req.headers[headerName.toLowerCase()];
      if (actualValue === headerValue) {
        return true;
      }
    }
    return false;
  }

  // Weighted round-robin over the candidate pool (with format preference).
  // Pool selection happens per-call so excludes / format filters don't desync state.
  // When multiple candidates tie on cumulative weight (common with equal config
  // weights), we break the tie by preferring lower avgLatencyMs. Unmeasured
  // upstreams (avgLatencyMs == 0) get the median of measured ones, so they
  // participate fairly until they accumulate their own data.
  private getLoadBalancedUpstream(req: RouteRequest): UpstreamState | null {
    const pool = this.preferFormat(this.candidates(req), req.format);
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    // Latency reference for tie-breaker: median of measured upstreams in pool;
    // fall back to 1000 ms if none have data yet.
    const measured = pool.map(u => u.avgLatencyMs).filter(v => v > 0).sort((a, b) => a - b);
    const medianLatency = measured.length > 0
      ? measured[Math.floor(measured.length / 2)]
      : 1000;
    const effLatency = (u: UpstreamState) => u.avgLatencyMs > 0 ? u.avgLatencyMs : medianLatency;

    let selected: UpstreamState | null = null;
    let maxWeight = -Infinity;
    let bestLatency = Infinity;
    let totalWeight = 0;

    for (const u of pool) {
      const cur = (this.currentWeights.get(u.name) ?? 0) + u.weight;
      this.currentWeights.set(u.name, cur);
      totalWeight += u.weight;
      const lat = effLatency(u);
      if (cur > maxWeight || (cur === maxWeight && lat < bestLatency)) {
        maxWeight = cur;
        bestLatency = lat;
        selected = u;
      }
    }

    if (selected) {
      this.currentWeights.set(
        selected.name,
        (this.currentWeights.get(selected.name) ?? 0) - totalWeight
      );
    }
    return selected;
  }

  setStrategy(strategy: RoutingStrategy): void {
    this.strategy = strategy;
  }

  getStrategy(): RoutingStrategy {
    return this.strategy;
  }
}

export const requestRouter = new RequestRouter();
