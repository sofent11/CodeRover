// FILE: bridge-types.ts
// Purpose: Shared TypeScript boundary types for bridge RPC, threads, providers, transport, and workspace/git payloads.

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcEnvelope {
  jsonrpc?: "2.0" | string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export interface RuntimeProviderShape {
  id: string;
  title: string;
  defaultModelId?: string | null;
  supports: Record<string, boolean>;
}

export interface RuntimeItemShape {
  id?: string;
  type?: string;
  role?: string | null;
  createdAt?: string | null;
  [key: string]: unknown;
}

export interface RuntimeTurnShape {
  id?: string;
  createdAt?: string | null;
  status?: string | null;
  items?: RuntimeItemShape[];
  [key: string]: unknown;
}

export interface RuntimeThreadShape {
  id?: string;
  provider?: string;
  providerSessionId?: string | null;
  title?: string | null;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
  turns?: RuntimeTurnShape[];
  [key: string]: unknown;
}

export interface HistoryCursorShape {
  threadId: string;
  createdAt: string;
  itemId?: string | null;
  turnId?: string | null;
  ordinal?: number | null;
}

export interface TransportCandidateShape {
  kind: string;
  url: string;
  label?: string | null;
}
