import { Hono } from 'hono';
import { upstreamManager } from '../services/upstream.ts';
import { forwardRequest } from '../services/forward.ts';
import type { OpenAIRequest } from '../types/index.ts';

const app = new Hono();

app.post('/chat/completions', async (c) => {
  const body = await c.req.json<OpenAIRequest>();
  return forwardRequest(c, 'openai', body);
});

// Synthesized model list — one entry per enabled upstream's bound model.
// (Client's chosen model name doesn't drive routing; this is informational.)
app.get('/models', (c) => {
  const upstreams = upstreamManager.getAllUpstreams().filter(u => u.enabled);
  const created = Math.floor(Date.now() / 1000);
  return c.json({
    object: 'list',
    data: upstreams.map(u => ({
      id: u.model,
      object: 'model',
      created,
      owned_by: u.name
    }))
  });
});

export default app;
