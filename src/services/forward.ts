import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import type { RequestFormat, UpstreamState } from '../types/index.ts';
import { requestRouter } from './router.ts';
import { upstreamManager } from './upstream.ts';
import {
  anthropicToOpenAI,
  openaiToAnthropic,
  openaiResponseToAnthropic,
  anthropicResponseToOpenAI
} from './converter.ts';
import {
  iterateSSE,
  createAnthropicUsageExtractor,
  createOpenAIUsageExtractor
} from './sseStream.ts';

// Decide whether a non-2xx upstream response is worth retrying.
function shouldRetry(status: number): boolean {
  return status >= 500 || status === 429;
}

// Verbose request/response logging when AIROUTER_DEBUG=1 (or =true).
const DEBUG = process.env.AIROUTER_DEBUG === '1' || process.env.AIROUTER_DEBUG === 'true';

function dbg(msg: string, extra?: unknown): void {
  if (!DEBUG) return;
  if (extra !== undefined) console.log(`[forward:debug] ${msg}`, extra);
  else console.log(`[forward:debug] ${msg}`);
}

// Mask secret-looking header values so debug logs don't leak keys.
function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'x-api-key' || lk === 'cookie') {
      out[k] = v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function truncate(s: string, max = 1024): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}... (${s.length - max} bytes truncated)`;
}

// Strip trailing /v1 (or /v1/) so we can append a fixed suffix.
function normalizeBase(baseurl: string): string {
  return baseurl.replace(/\/v1\/?$/, '');
}

function targetUrl(upstream: UpstreamState, incomingUrl?: string): string {
  const base = normalizeBase(upstream.baseurl);
  const path = upstream.type === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  // Preserve the incoming query string (e.g. ?beta=true) — some upstreams use
  // it to gate specific behaviors. Without this, requests silently lose flags
  // and may fall through to a different upstream code path.
  let query = '';
  if (incomingUrl) {
    const qIdx = incomingUrl.indexOf('?');
    if (qIdx >= 0) query = incomingUrl.slice(qIdx);
  }
  return `${base}${path}${query}`;
}

// Headers we must NOT forward verbatim from the client to the upstream:
// - hop-by-hop headers (RFC 7230)
// - host (different target)
// - auth headers (we replace with the upstream's key)
// - content-length / content-encoding / accept-encoding (body re-serialized; avoid encoding mismatch)
const HEADER_DROP_SET = new Set<string>([
  'host',
  'authorization',
  'x-api-key',
  'content-length',
  'content-encoding',
  'accept-encoding',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

// Build the request headers airouter sends to the upstream.
// Strategy: passthrough the client's original headers (preserving User-Agent,
// anthropic-beta, x-stainless-*, etc. — many upstreams fingerprint on these),
// drop hop-by-hop / auth / encoding headers, then layer in our own auth + content-type.
// All header keys are lowercased internally so we never end up with duplicate
// casings (e.g. "content-type" + "Content-Type") which fetch concatenates
// into "application/json, application/json" — Spring/etc. reject that.
// anthropic-version is only injected if the client didn't already send one, so
// we never downgrade a newer client.
function buildUpstreamHeaders(
  clientHeaders: Record<string, string>,
  upstream: UpstreamState
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    const lk = k.toLowerCase();
    if (HEADER_DROP_SET.has(lk)) continue;
    out[lk] = v;
  }
  out['content-type'] = 'application/json';
  if (upstream.type === 'anthropic') {
    // Default: Anthropic-style x-api-key. Some compatible gateways (e.g. idealab)
    // require Authorization: Bearer instead — opt in via authStyle: 'bearer'.
    if (upstream.authStyle === 'bearer') {
      out['authorization'] = `Bearer ${upstream.key}`;
    } else {
      out['x-api-key'] = upstream.key;
    }
    if (!('anthropic-version' in out)) {
      out['anthropic-version'] = '2023-06-01';
    }
  } else {
    out['authorization'] = `Bearer ${upstream.key}`;
  }
  return out;
}

// Translate the body into the upstream's wire format.
function adaptRequestBody(
  format: RequestFormat,
  upstream: UpstreamState,
  body: any
): any {
  if (format === upstream.type) return body;
  return format === 'openai'
    ? openaiToAnthropic(body)
    : anthropicToOpenAI(body);
}

// Translate the upstream non-streaming response back to the client's format.
function adaptResponseBody(
  format: RequestFormat,
  upstream: UpstreamState,
  data: any
): any {
  if (format === upstream.type) return data;
  return upstream.type === 'openai'
    ? openaiResponseToAnthropic(data)
    : anthropicResponseToOpenAI(data);
}

// Token usage extraction from the non-streaming response, using the upstream's
// native field names (we record before any client-format conversion).
function extractUsage(upstream: UpstreamState, data: any): { inputTokens: number; outputTokens: number } | null {
  if (upstream.type === 'anthropic') {
    const u = data?.usage;
    if (!u) return null;
    return { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
  }
  const u = data?.usage;
  if (!u) return null;
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function forwardRequest(
  c: Context,
  format: RequestFormat,
  body: any
): Promise<Response> {
  const headers = Object.fromEntries(c.req.raw.headers);
  const failover = upstreamManager.getFailoverConfig();
  const maxAttempts = failover.enabled ? failover.maxRetries + 1 : 1;
  const tried = new Set<string>();
  let lastStatus = 502;
  let lastError = 'all upstreams failed';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const upstream = requestRouter.getNextUpstream({
      format,
      model: body?.model,
      headers,
      exclude: tried
    });
    if (!upstream) break;
    tried.add(upstream.name);

    upstreamManager.recordRequest(upstream.name);
    const startTime = Date.now();
    const url = targetUrl(upstream, c.req.raw.url);
    const formatMismatch = format !== upstream.type;
    const clientWantsStream = !!body?.stream;

    // When format-mismatched + streaming, we ask upstream non-streaming and
    // synthesize an SSE burst back to the client.
    // Always overwrite body.model — client's model field is informational only;
    // the actual model is bound to the upstream.
    const upstreamBody = formatMismatch
      ? { ...adaptRequestBody(format, upstream, body), stream: false, model: upstream.model }
      : { ...body, model: upstream.model };

    const outgoingHeaders = buildUpstreamHeaders(headers, upstream);
    const outgoingBody = JSON.stringify(upstreamBody);
    dbg(`→ ${upstream.name} POST ${url} (body ${outgoingBody.length} bytes)`);
    dbg(`  headers:`, redactHeaders(outgoingHeaders));
    if (DEBUG) dbg(`  body:`, truncate(outgoingBody, 2048));

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        { method: 'POST', headers: outgoingHeaders, body: outgoingBody },
        failover.timeout
      );
    } catch (err) {
      console.error(`[forward] ${upstream.name} fetch failed (attempt ${attempt + 1}): ${String(err)}`);
      upstreamManager.recordFailure(upstream.name);
      lastError = `network error: ${String(err)}`;
      continue;
    }

    dbg(`← ${upstream.name} HTTP ${response.status}`);
    if (DEBUG) {
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { respHeaders[k] = v; });
      dbg(`  response headers:`, respHeaders);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      // Always log the error body — that's what tells us WHY upstream failed.
      console.error(
        `[forward] ${upstream.name} HTTP ${response.status} (attempt ${attempt + 1}): ${truncate(errBody, 2048)}`
      );
      if (shouldRetry(response.status)) {
        upstreamManager.recordFailure(upstream.name);
        lastStatus = response.status;
        lastError = errBody || `HTTP ${response.status}`;
        continue;
      }
      // 4xx (other than 429) is a client problem — propagate, no retry.
      upstreamManager.recordFailure(upstream.name);
      return c.json(
        { error: `Upstream error: ${response.status}`, details: errBody },
        response.status as ContentfulStatusCode
      );
    }

    // Success path — diverge by streaming/non-streaming and format match.
    if (clientWantsStream && !formatMismatch) {
      // Same-format streaming: passthrough event blocks, extract usage in parallel.
      return streamPassthrough(c, response, upstream);
    }

    if (clientWantsStream && formatMismatch) {
      // Cross-format streaming: read full upstream response, convert, emit synthetic SSE.
      const upstreamData = await response.json().catch(() => null) as any;
      if (!upstreamData) {
        upstreamManager.recordFailure(upstream.name);
        lastError = 'invalid upstream response';
        continue;
      }
      const usage = extractUsage(upstream, upstreamData);
      if (usage) upstreamManager.recordTokenUsage(upstream.name, usage);
      upstreamManager.recordSuccess(upstream.name);
      upstreamManager.recordLatency(upstream.name, Date.now() - startTime);
      return synthesizeStream(c, format, upstream, upstreamData);
    }

    // Non-streaming
    const data = await response.json().catch(() => null) as any;
    if (!data) {
      upstreamManager.recordFailure(upstream.name);
      lastError = 'invalid upstream response';
      continue;
    }
    const usage = extractUsage(upstream, data);
    if (usage) upstreamManager.recordTokenUsage(upstream.name, usage);
    upstreamManager.recordSuccess(upstream.name);
    upstreamManager.recordLatency(upstream.name, Date.now() - startTime);

    return c.json(adaptResponseBody(format, upstream, data));
  }

  return c.json({ error: lastError }, (lastStatus as ContentfulStatusCode) || 502);
}

// ─── Streaming helpers ─────────────────────────────────────────

function streamPassthrough(
  c: Context,
  response: Response,
  upstream: UpstreamState
): Response {
  const startTime = Date.now();
  const extractor = upstream.type === 'anthropic'
    ? createAnthropicUsageExtractor()
    : createOpenAIUsageExtractor();

  return streamSSE(c, async (stream) => {
    if (!response.body) return;
    try {
      for await (const evt of iterateSSE(response.body)) {
        // Emit verbatim so we don't reformat/lose anything.
        await stream.writeSSE({
          data: evt.data ?? '',
          ...(evt.event ? { event: evt.event } : {})
        });
        extractor.feed(evt);
      }
      const usage = extractor.finalize();
      if (usage) upstreamManager.recordTokenUsage(upstream.name, usage);
      upstreamManager.recordSuccess(upstream.name);
      upstreamManager.recordLatency(upstream.name, Date.now() - startTime);
    } catch (err) {
      console.error(`[forward] stream error from ${upstream.name}:`, err);
      upstreamManager.recordFailure(upstream.name);
    }
  });
}

// Cross-format streaming: emit a minimal but valid SSE sequence in the client's format.
function synthesizeStream(
  c: Context,
  format: RequestFormat,
  upstream: UpstreamState,
  upstreamData: any
): Response {
  // Convert the response into the client's non-streaming shape first.
  const converted = format === upstream.type
    ? upstreamData
    : (upstream.type === 'openai'
        ? openaiResponseToAnthropic(upstreamData)
        : anthropicResponseToOpenAI(upstreamData));

  return streamSSE(c, async (stream) => {
    if (format === 'anthropic') {
      const text = converted?.content?.[0]?.text ?? '';
      const usage = converted?.usage ?? { input_tokens: 0, output_tokens: 0 };
      const messageId = converted?.id || `msg_${Date.now()}`;
      const model = converted?.model || 'unknown';

      await stream.writeSSE({
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            id: messageId, type: 'message', role: 'assistant', model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: usage.input_tokens, output_tokens: 0 }
          }
        })
      });
      await stream.writeSSE({
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' }
        })
      });
      await stream.writeSSE({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text }
        })
      });
      await stream.writeSSE({
        event: 'content_block_stop',
        data: JSON.stringify({ type: 'content_block_stop', index: 0 })
      });
      await stream.writeSSE({
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: converted?.stop_reason || 'end_turn', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens }
        })
      });
      await stream.writeSSE({
        event: 'message_stop',
        data: JSON.stringify({ type: 'message_stop' })
      });
    } else {
      // OpenAI client format
      const choice = converted?.choices?.[0];
      const text = choice?.message?.content ?? '';
      const id = converted?.id || `chatcmpl_${Date.now()}`;
      const model = converted?.model || 'unknown';
      const created = converted?.created || Math.floor(Date.now() / 1000);

      await stream.writeSSE({
        data: JSON.stringify({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
        })
      });
      await stream.writeSSE({
        data: JSON.stringify({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason || 'stop' }]
        })
      });
      await stream.writeSSE({ data: '[DONE]' });
    }
  });
}
