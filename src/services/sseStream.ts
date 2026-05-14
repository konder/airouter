import type { TokenUsage } from '../types/index.ts';

export interface SSEEvent {
  raw: string;        // verbatim event block (for transparent passthrough)
  event?: string;     // event: <name>
  data?: string;      // joined data: lines (newline between multiple data: lines)
}

// Parse a complete SSE event block (one or more lines, no trailing blank).
function parseEventBlock(block: string): SSEEvent {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // SSE spec: strip ONE leading space if present
      let v = line.slice(5);
      if (v.startsWith(' ')) v = v.slice(1);
      dataLines.push(v);
    }
    // ignore comments (": ..."), id:, retry:
  }
  return {
    raw: block,
    event,
    data: dataLines.length > 0 ? dataLines.join('\n') : undefined
  };
}

// Iterate over a fetch ReadableStream, yielding one SSEEvent per event-block.
// Handles chunk-boundary unalignment via a rolling text buffer split on \n\n.
export async function* iterateSSE(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any trailing event (if upstream forgot final \n\n)
        const tail = buffer.trim();
        if (tail) yield parseEventBlock(tail);
        decoder.decode();
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      // Split on event delimiter (\n\n). Keep the trailing partial in buffer.
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.length > 0) yield parseEventBlock(block);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
}

// ─── Usage extractors ──────────────────────────────────────────

export interface UsageExtractor {
  feed(evt: SSEEvent): void;
  finalize(): TokenUsage | null;
}

// Anthropic streams usage in two events:
//   event: message_start  → data.message.usage.input_tokens (and partial output)
//   event: message_delta  → data.usage.output_tokens (cumulative)
export function createAnthropicUsageExtractor(): UsageExtractor {
  let input = 0;
  let output = 0;
  let seen = false;
  return {
    feed(evt) {
      if (!evt.data) return;
      let parsed: any;
      try { parsed = JSON.parse(evt.data); } catch { return; }
      if (evt.event === 'message_start') {
        const u = parsed?.message?.usage;
        if (u) {
          input = u.input_tokens ?? input;
          output = u.output_tokens ?? output;
          seen = true;
        }
      } else if (evt.event === 'message_delta') {
        const u = parsed?.usage;
        if (u) {
          // output_tokens here is cumulative, not delta
          if (typeof u.output_tokens === 'number') output = u.output_tokens;
          if (typeof u.input_tokens === 'number') input = u.input_tokens;
          seen = true;
        }
      }
    },
    finalize() {
      return seen ? { inputTokens: input, outputTokens: output } : null;
    }
  };
}

// OpenAI streams usage on the final chunk (only when stream_options.include_usage=true,
// which the upstream may or may not return). We just look opportunistically.
export function createOpenAIUsageExtractor(): UsageExtractor {
  let input = 0;
  let output = 0;
  let seen = false;
  return {
    feed(evt) {
      if (!evt.data || evt.data === '[DONE]') return;
      let parsed: any;
      try { parsed = JSON.parse(evt.data); } catch { return; }
      const u = parsed?.usage;
      if (u && (typeof u.prompt_tokens === 'number' || typeof u.completion_tokens === 'number')) {
        input = u.prompt_tokens ?? input;
        output = u.completion_tokens ?? output;
        seen = true;
      }
    },
    finalize() {
      return seen ? { inputTokens: input, outputTokens: output } : null;
    }
  };
}
