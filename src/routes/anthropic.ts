import { Hono } from 'hono';
import { forwardRequest } from '../services/forward.ts';
import type { AnthropicRequest } from '../types/index.ts';

const app = new Hono();

app.post('/messages', async (c) => {
  const body = await c.req.json<AnthropicRequest>();
  return forwardRequest(c, 'anthropic', body);
});

export default app;
