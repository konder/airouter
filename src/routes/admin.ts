import { Hono } from 'hono';
import { upstreamManager } from '../services/upstream.ts';
import { requestRouter } from '../services/router.ts';
import { getConfig } from '../config/index.ts';
import type { Upstream } from '../types/index.ts';

const app = new Hono();

// List all upstreams with their status
app.get('/upstreams', (c) => {
  const upstreams = upstreamManager.getAllUpstreams();
  return c.json({
    upstreams: upstreams.map(u => ({
      name: u.name,
      type: u.type,
      baseurl: u.baseurl,
      model: u.model,
      group: u.group ?? null,
      weight: u.weight,
      enabled: u.enabled,
      healthy: u.healthy,
      consecutiveFailures: u.consecutiveFailures,
      unhealthySince: u.unhealthySince,
      requestCount: u.requestCount,
      errorCount: u.errorCount,
      latencyMs: u.latencyMs,
      avgLatencyMs: u.avgLatencyMs,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      totalTokens: u.totalTokens,
      lastCheck: u.lastCheck
    }))
  });
});

// Get routing status
app.get('/routing', (c) => {
  const config = getConfig();
  return c.json({
    strategy: requestRouter.getStrategy(),
    config: config.routing
  });
});

// Enable an upstream
app.post('/upstreams/:name/enable', (c) => {
  const name = c.req.param('name');
  const success = upstreamManager.enableUpstream(name);

  if (success) {
    return c.json({ message: `Upstream ${name} enabled`, name });
  } else {
    return c.json({ error: `Upstream ${name} not found` }, 404);
  }
});

// Disable an upstream
app.post('/upstreams/:name/disable', (c) => {
  const name = c.req.param('name');
  const success = upstreamManager.disableUpstream(name);

  if (success) {
    return c.json({ message: `Upstream ${name} disabled`, name });
  } else {
    return c.json({ error: `Upstream ${name} not found` }, 404);
  }
});

// Mark upstream as healthy
app.post('/upstreams/:name/healthy', (c) => {
  const name = c.req.param('name');
  upstreamManager.markHealthy(name);
  return c.json({ message: `Upstream ${name} marked as healthy`, name });
});

// Mark upstream as unhealthy
app.post('/upstreams/:name/unhealthy', (c) => {
  const name = c.req.param('name');
  upstreamManager.markUnhealthy(name);
  return c.json({ message: `Upstream ${name} marked as unhealthy`, name });
});

// Switch routing strategy
app.post('/routing/strategy', async (c) => {
  const body = await c.req.json<{ strategy: 'load-balance' | 'rules' | 'manual' }>();

  if (!['load-balance', 'rules', 'manual'].includes(body.strategy)) {
    return c.json({ error: 'Invalid strategy. Must be one of: load-balance, rules, manual' }, 400);
  }

  requestRouter.setStrategy(body.strategy);
  // Keep the in-memory config in sync so /admin/config/save persists this change.
  getConfig().routing.strategy = body.strategy;
  return c.json({
    message: `Routing strategy changed to ${body.strategy}`,
    strategy: body.strategy
  });
});

// Set the default upstream (only meaningful when strategy === 'manual').
// Pass {"name": null} to clear it.
app.post('/routing/default-upstream', async (c) => {
  const body = await c.req.json<{ name: string | null }>();
  const config = getConfig();
  if (body.name === null || body.name === undefined || body.name === '') {
    config.routing.defaultUpstream = undefined;
    return c.json({ message: 'Default upstream cleared', defaultUpstream: null });
  }
  if (!upstreamManager.getUpstream(body.name)) {
    return c.json({ error: `Unknown upstream: ${body.name}` }, 400);
  }
  config.routing.defaultUpstream = body.name;
  return c.json({
    message: `Default upstream set to ${body.name}`,
    defaultUpstream: body.name
  });
});

// Get server status
app.get('/status', (c) => {
  const config = getConfig();
  const upstreams = upstreamManager.getAllUpstreams();
  const enabled = upstreams.filter(u => u.enabled);
  const healthy = upstreams.filter(u => u.healthy);

  return c.json({
    server: {
      host: config.server.host,
      port: config.server.port
    },
    routing: {
      strategy: requestRouter.getStrategy()
    },
    upstreams: {
      total: upstreams.length,
      enabled: enabled.length,
      healthy: healthy.length
    },
    tokens: {
      totalInput: upstreams.reduce((sum, u) => sum + u.inputTokens, 0),
      totalOutput: upstreams.reduce((sum, u) => sum + u.outputTokens, 0),
      total: upstreams.reduce((sum, u) => sum + u.totalTokens, 0)
    }
  });
});

// Measure latency for a specific upstream
app.post('/upstreams/:name/measure', async (c) => {
  const name = c.req.param('name');
  const latency = await upstreamManager.measureLatency(name);

  if (latency < 0) {
    return c.json({ error: `Failed to measure latency for ${name}`, name }, 500);
  }

  const upstream = upstreamManager.getUpstream(name);
  return c.json({
    name,
    latencyMs: latency,
    avgLatencyMs: upstream?.avgLatencyMs,
    healthy: upstream?.healthy
  });
});

// Measure latency for all upstreams
app.post('/upstreams/measure-all', async (c) => {
  const results = await upstreamManager.measureAllLatencies();
  return c.json({ results });
});

// Get token statistics
app.get('/tokens', (c) => {
  const upstreams = upstreamManager.getAllUpstreams();

  return c.json({
    summary: {
      totalInput: upstreams.reduce((sum, u) => sum + u.inputTokens, 0),
      totalOutput: upstreams.reduce((sum, u) => sum + u.outputTokens, 0),
      total: upstreams.reduce((sum, u) => sum + u.totalTokens, 0)
    },
    byUpstream: upstreams.map(u => ({
      name: u.name,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      totalTokens: u.totalTokens,
      requestCount: u.requestCount,
      avgInputPerRequest: u.requestCount > 0 ? Math.round(u.inputTokens / u.requestCount) : 0,
      avgOutputPerRequest: u.requestCount > 0 ? Math.round(u.outputTokens / u.requestCount) : 0
    }))
  });
});

// Recent token activity buckets (10s granularity).
// Used by the TUI Activity chart. Empty buckets are omitted.
app.get('/activity', (c) => {
  return c.json(upstreamManager.getActivity());
});

// Get latency statistics
app.get('/latency', (c) => {
  const upstreams = upstreamManager.getAllUpstreams();

  return c.json({
    byUpstream: upstreams.map(u => ({
      name: u.name,
      latencyMs: u.latencyMs,
      avgLatencyMs: u.avgLatencyMs,
      healthy: u.healthy,
      requestCount: u.requestCount
    }))
  });
});

// === Upstream CRUD ===

// Add a new upstream
app.post('/upstreams', async (c) => {
  const body = await c.req.json<Partial<Upstream>>();

  // Validate required fields
  if (!body.name) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (!body.type || !['openai', 'anthropic'].includes(body.type)) {
    return c.json({ error: 'type must be "openai" or "anthropic"' }, 400);
  }
  if (!body.baseurl) {
    return c.json({ error: 'baseurl is required' }, 400);
  }
  if (!body.key) {
    return c.json({ error: 'key is required' }, 400);
  }
  if (!body.model) {
    return c.json({ error: 'model is required' }, 400);
  }

  const upstream: Upstream = {
    name: body.name,
    type: body.type,
    baseurl: body.baseurl,
    key: body.key,
    model: body.model,
    group: body.group || undefined,
    weight: body.weight || 1,
    enabled: body.enabled !== false,
    authStyle: body.authStyle
  };

  const result = upstreamManager.addUpstream(upstream);
  if (result.success) {
    return c.json({ message: result.message, upstream }, 201);
  } else {
    return c.json({ error: result.message }, 400);
  }
});

// Get upstream config
app.get('/upstreams/:name/config', (c) => {
  const name = c.req.param('name');
  const upstream = upstreamManager.getUpstreamConfig(name);

  if (!upstream) {
    return c.json({ error: `Upstream ${name} not found` }, 404);
  }

  return c.json({ upstream });
});

// Update upstream (supports rename via body.name)
app.patch('/upstreams/:name', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json<Partial<Upstream>>();

  if ('model' in body && !body.model) {
    return c.json({ error: 'model cannot be empty' }, 400);
  }

  const result = upstreamManager.updateUpstream(name, body);
  if (result.success) {
    const lookupName = body.name || name;
    const updated = upstreamManager.getUpstreamConfig(lookupName);
    return c.json({ message: result.message, upstream: updated });
  } else {
    return c.json({ error: result.message }, 400);
  }
});

// Delete upstream
app.delete('/upstreams/:name', (c) => {
  const name = c.req.param('name');
  const result = upstreamManager.deleteUpstream(name);

  if (result.success) {
    return c.json({ message: result.message });
  } else {
    return c.json({ error: result.message }, 404);
  }
});

// Persist config to file
app.post('/config/save', (c) => {
  const result = upstreamManager.persistConfig();
  if (result.success) {
    return c.json({ message: result.message });
  } else {
    return c.json({ error: result.message }, 500);
  }
});

export default app;