import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { getConfig } from './config/index.ts';
import { keysManager } from './services/keys.ts';

// Import routes
import openaiRoutes from './routes/openai.ts';
import anthropicRoutes from './routes/anthropic.ts';
import adminRoutes from './routes/admin.ts';


const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Client API key auth — gate /v1/* only. /admin/* and /health stay open
// (daemon binds to 127.0.0.1 by default, so admin is local-only).
app.use('/v1/*', async (c, next) => {
  const xkey = c.req.header('x-api-key');
  const auth = c.req.header('authorization');
  const value = (xkey || auth?.replace(/^Bearer\s+/i, ''))?.trim();
  if (!value) {
    return c.json({ error: { type: 'authentication_error', message: 'Missing API key' } }, 401);
  }
  if (!keysManager.validate(value)) {
    return c.json({ error: { type: 'authentication_error', message: 'Invalid API key' } }, 401);
  }
  keysManager.recordUse(value);
  await next();
});

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'AI Router',
    version: '1.0.0',
    status: 'running'
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// API routes
app.route('/v1', openaiRoutes);
app.route('/v1', anthropicRoutes);
app.route('/admin', adminRoutes);


// Start server
const config = getConfig();
const port = config.server.port;
const host = config.server.host;

console.log(`Starting AI Router on ${host}:${port}`);

serve({
  fetch: app.fetch,
  port,
  hostname: host
});

console.log(`AI Router is running at http://${host}:${port}`);
console.log(`OpenAI endpoint: http://${host}:${port}/v1/chat/completions`);
console.log(`Anthropic endpoint: http://${host}:${port}/v1/messages`);
console.log(`Admin API: http://${host}:${port}/admin/upstreams`);

console.log(`TUI: npm run tui`);