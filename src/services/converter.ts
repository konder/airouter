import type { OpenAIRequest, AnthropicRequest, OpenAIMessage, AnthropicMessage } from '../types/index.ts';

// Convert Anthropic request to OpenAI format
export function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // Add system message if present
  if (req.system) {
    messages.push({
      role: 'system',
      content: req.system
    });
  }

  // Convert messages
  for (const msg of req.messages) {
    messages.push({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : convertAnthropicContent(msg.content)
    });
  }

  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop_sequences
  };
}

// Convert OpenAI request to Anthropic format
export function openaiToAnthropic(req: OpenAIRequest): AnthropicRequest {
  let system: string | undefined;
  const messages: AnthropicMessage[] = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      system = typeof msg.content === 'string' ? msg.content : '';
    } else {
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: typeof msg.content === 'string' ? msg.content : convertOpenAIContent(msg.content)
      });
    }
  }

  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens || 4096,
    system,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    stop_sequences: typeof req.stop === 'string' ? [req.stop] : req.stop
  };
}

function convertAnthropicContent(content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>): string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> {
  return content.map(item => {
    if (item.type === 'text') {
      return { type: 'text' as const, text: item.text };
    } else if (item.type === 'image' && item.source) {
      return {
        type: 'image_url' as const,
        image_url: { url: `data:${item.source.media_type};base64,${item.source.data}` }
      };
    }
    return { type: 'text' as const, text: '' };
  });
}

function convertOpenAIContent(content: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>): string | Array<{ type: 'text' | 'image'; text?: string; source?: { type: string; media_type: string; data: string } }> {
  return content.map(item => {
    if (item.type === 'text') {
      return { type: 'text' as const, text: item.text };
    } else if (item.type === 'image_url' && item.image_url) {
      const url = item.image_url.url;
      if (url.startsWith('data:')) {
        const [prefix, data] = url.split(',');
        const mediaType = prefix.match(/data:([^;]+)/)?.[1] || 'image/png';
        return {
          type: 'image' as const,
          source: {
            type: 'base64',
            media_type: mediaType,
            data
          }
        };
      }
    }
    return { type: 'text' as const, text: '' };
  });
}

// ─── Response converters (non-streaming) ───────────────────────

// finish_reason ↔ stop_reason mapping
const OPENAI_TO_ANTHROPIC_STOP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn'
};
const ANTHROPIC_TO_OPENAI_STOP: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls'
};

// Convert an OpenAI chat-completion response into Anthropic /v1/messages shape.
export function openaiResponseToAnthropic(data: any): any {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? '';
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => c?.text || '').join('')
      : '';
  return {
    id: data?.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: data?.model,
    content: [{ type: 'text', text }],
    stop_reason: OPENAI_TO_ANTHROPIC_STOP[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data?.usage?.prompt_tokens ?? 0,
      output_tokens: data?.usage?.completion_tokens ?? 0
    }
  };
}

// Convert an Anthropic /v1/messages response into OpenAI chat-completion shape.
export function anthropicResponseToOpenAI(data: any): any {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b?.text || '')
    .join('');
  return {
    id: data?.id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data?.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: ANTHROPIC_TO_OPENAI_STOP[data?.stop_reason] || 'stop'
    }],
    usage: {
      prompt_tokens: data?.usage?.input_tokens ?? 0,
      completion_tokens: data?.usage?.output_tokens ?? 0,
      total_tokens: (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0)
    }
  };
}