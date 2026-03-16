// FILE: bridge-types.ts
// Purpose: Shared TypeScript boundary types for bridge RPC, runtime state, transport, and plan-mode payloads.

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequestShape<TParams = Record<string, unknown>> {
  jsonrpc?: "2.0" | string;
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotificationShape<TParams = Record<string, unknown>> {
  jsonrpc?: "2.0" | string;
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccessShape<TResult = unknown> {
  jsonrpc?: "2.0" | string;
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcFailureShape {
  jsonrpc?: "2.0" | string;
  id: JsonRpcId;
  error: JsonRpcErrorShape;
}

export type JsonRpcEnvelope<TParams = Record<string, unknown>, TResult = unknown> =
  | JsonRpcRequestShape<TParams>
  | JsonRpcNotificationShape<TParams>
  | JsonRpcSuccessShape<TResult>
  | JsonRpcFailureShape;

export interface RuntimeAccessMode {
  id: string;
  title: string;
}

export interface RuntimeCapabilities extends Record<string, boolean> {
  planMode: boolean;
  structuredUserInput: boolean;
  inlineApproval: boolean;
  turnSteer: boolean;
  reasoningOptions: boolean;
  desktopRefresh: boolean;
  desktopRestart: boolean;
}

export interface RuntimeProviderShape {
  id: string;
  title: string;
  defaultModelId: string | null;
  supports: RuntimeCapabilities;
  accessModes: RuntimeAccessMode[];
}

export interface RuntimeReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface RuntimeModelShape {
  id: string;
  model: string;
  title: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: RuntimeReasoningEffortOption[];
  defaultReasoningEffort: string | null;
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
  archived?: boolean;
  current_working_directory?: string | null;
  working_directory?: string | null;
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

export interface PlanModeStepShape {
  step: string;
  status: string;
}

export interface PlanModeStateShape {
  explanation: string | null;
  steps: PlanModeStepShape[];
}

export interface RuntimeTextInputItem {
  type: "text";
  text: string;
}

export interface RuntimeImageInputItem {
  type: "image" | "local_image";
  image_url?: string;
  url?: string;
  path?: string;
}

export interface RuntimeSkillInputItem {
  type: "skill";
  id: string;
  name?: string;
  path?: string;
}

export type RuntimeInputItem =
  | RuntimeTextInputItem
  | RuntimeImageInputItem
  | RuntimeSkillInputItem
  | ({ type: string } & Record<string, unknown>);
