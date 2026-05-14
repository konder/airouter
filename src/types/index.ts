// Upstream provider types
export type UpstreamType = 'openai' | 'anthropic';

// Wire format the client used to call us
export type RequestFormat = 'openai' | 'anthropic';

// How to inject the upstream credential into outgoing requests.
//   x-api-key: send `x-api-key: <key>`     (Anthropic official + most "anthropic-compatible")
//   bearer:    send `Authorization: Bearer <key>` (some custom anthropic gateways e.g. idealab)
// Only meaningful for type:anthropic upstreams; openai always uses bearer.
export type AuthStyle = 'x-api-key' | 'bearer';

export interface Upstream {
  name: string;
  type: UpstreamType;
  baseurl: string;
  key: string;
  model: string;   // The actual model id sent to the upstream — overrides client body.model
  group?: string;  // Logical group for routing. Client body.model is matched against this. Default: ungrouped
  weight: number;
  enabled: boolean;
  authStyle?: AuthStyle; // anthropic-only override; default 'x-api-key'
}

export interface RoutingRules {
  header?: string; // "Header-Name: value" format
  upstream: string;
}

export interface FailoverConfig {
  enabled: boolean;
  maxRetries: number;
  timeout: number; // ms
  healthThreshold?: number; // consecutive failures before marking unhealthy (default 3)
  cooldownMs?: number;      // probe again after this much time (default 30000)
}

export interface RoutingConfig {
  strategy: 'load-balance' | 'rules' | 'manual';
  defaultUpstream?: string; // for manual strategy
  defaultGroup?: string;    // fallback group when client model doesn't match any upstream's group
  rules?: RoutingRules[];
  failover: FailoverConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface Config {
  server: ServerConfig;
  upstreams: Upstream[];
  routing: RoutingConfig;
}

// Request/Response types
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image'; text?: string; source?: { type: string; media_type: string; data: string } }>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

// Runtime state
export interface UpstreamState extends Upstream {
  healthy: boolean;
  lastCheck?: Date;
  requestCount: number;
  errorCount: number;
  // Health management
  consecutiveFailures: number;
  unhealthySince?: Date;
  // Latency stats
  latencyMs: number; // Latest measured latency
  avgLatencyMs: number; // Average latency
  // Token stats
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// Client-issued API keys (the keys clients use to call this local daemon).
// Stored separately from config.yaml in ~/.airouter/keys.yaml.
export interface ApiKey {
  name: string;
  value: string;       // 'air_' + 32 hex chars
  created: string;     // ISO timestamp
  lastUsed?: string;   // ISO timestamp, set on first use
  requestCount: number;
}

export interface KeysFile {
  keys: ApiKey[];
}