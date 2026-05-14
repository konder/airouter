import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { getConfig } from './config/index.ts';

// Import routes
import openaiRoutes from './routes/openai.ts';
import anthropicRoutes from './routes/anthropic.ts';
import adminRoutes from './routes/admin.ts';


const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

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