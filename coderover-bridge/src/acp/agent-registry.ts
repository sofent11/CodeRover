// FILE: acp/agent-registry.ts
// Purpose: Resolves logical bridge agents to ACP adapter commands.

export interface AcpAgentDefinition {
  id: string;
  name: string;
  command: string;
  description: string;
  defaultModelId?: string | null;
  supports?: Record<string, unknown> | null;
}

export interface AcpAgentRegistry {
  defaultAgentId: string;
  get(agentId: unknown): AcpAgentDefinition | null;
  list(): AcpAgentDefinition[];
}

const DEFAULT_AGENT_ID = "codex";

const BUILTIN_AGENTS: AcpAgentDefinition[] = [
  {
    id: "codex",
    name: "Codex",
    command: "npx @zed-industries/codex-acp",
    description: "Codex ACP adapter",
    defaultModelId: null,
    supports: {
      planMode: true,
      structuredUserInput: true,
      inlineApproval: true,
      turnSteer: true,
      reasoningOptions: true,
      desktopRefresh: true,
      desktopRestart: true,
    },
  },
  {
    id: "claude",
    name: "Claude",
    command: "npx -y @zed-industries/claude-agent-acp",
    description: "Claude ACP adapter",
    defaultModelId: "sonnet",
    supports: {
      planMode: true,
      structuredUserInput: true,
      inlineApproval: true,
      turnSteer: false,
      reasoningOptions: true,
      desktopRefresh: false,
      desktopRestart: false,
    },
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini --acp",
    description: "Gemini ACP adapter",
    defaultModelId: "gemini-2.5-flash",
    supports: {
      planMode: false,
      structuredUserInput: false,
      inlineApproval: false,
      turnSteer: false,
      reasoningOptions: false,
      desktopRefresh: false,
      desktopRestart: false,
    },
  },
];

export function createAcpAgentRegistry(): AcpAgentRegistry {
  const byId = new Map<string, AcpAgentDefinition>(
    BUILTIN_AGENTS.map((agent) => [agent.id, resolveEnvOverride(agent)])
  );

  return {
    defaultAgentId: DEFAULT_AGENT_ID,
    get(agentId: unknown): AcpAgentDefinition | null {
      const normalized = normalizeAgentId(agentId);
      return normalized ? { ...(byId.get(normalized) || null) } : null;
    },
    list(): AcpAgentDefinition[] {
      return Array.from(byId.values(), (agent) => ({ ...agent }));
    },
  };
}

function resolveEnvOverride(agent: AcpAgentDefinition): AcpAgentDefinition {
  const envKey = `CODEROVER_${agent.id.toUpperCase()}_ACP_COMMAND`;
  const override = normalizeNonEmptyString(process.env[envKey]);
  if (!override) {
    return agent;
  }
  return {
    ...agent,
    command: override,
  };
}

function normalizeAgentId(value: unknown): string | null {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase();
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
