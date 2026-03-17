// FILE: acp/session-manager.ts
// Purpose: Bridge-local ACP session coordination around logical agents and spawned ACP adapter clients.

import { randomUUID } from "crypto";

import type { RuntimeSessionMeta, RuntimeStore } from "../runtime-store";
import type { SessionRuntimeIndex } from "../runtime-engine/session-runtime-index";
import type { AcpAgentDefinition, AcpAgentRegistry } from "./agent-registry";
import { createAcpProcessClient, type AcpProcessClient } from "./process-client";

export interface AcpSessionManager {
  createSession(params: {
    agentId: string;
    cwd?: string | null;
    modelId?: string | null;
  }): Promise<RuntimeSessionMeta>;
  getClient(agentId: string): Promise<AcpProcessClient>;
  getSessionMeta(sessionId: string): RuntimeSessionMeta | null;
  listSessions(params?: { archived?: boolean }): RuntimeSessionMeta[];
  shutdown(): void;
}

export function createAcpSessionManager({
  registry,
  store,
  sessionRuntimeIndex,
}: {
  registry: AcpAgentRegistry;
  store: RuntimeStore;
  sessionRuntimeIndex: SessionRuntimeIndex;
}): AcpSessionManager {
  const clients = new Map<string, AcpProcessClient>();
  const initializedAgents = new Set<string>();

  async function getClient(agentId: string): Promise<AcpProcessClient> {
    const definition = requireAgent(agentId);
    const existing = clients.get(definition.id);
    if (existing?.isRunning()) {
      await initializeClient(definition, existing);
      return existing;
    }

    existing?.close();
    const client = createAcpProcessClient(definition.command);
    clients.set(definition.id, client);
    await initializeClient(definition, client);
    return client;
  }

  async function initializeClient(definition: AcpAgentDefinition, client: AcpProcessClient): Promise<void> {
    if (initializedAgents.has(definition.id)) {
      return;
    }
    await client.initialize({
      clientInfo: {
        name: "coderover-bridge",
        title: "CodeRover Bridge",
        version: "1.0.0",
      },
      capabilities: {
        sessionModes: true,
        promptContent: true,
      },
    });
    initializedAgents.add(definition.id);
  }

  async function createSession({
    agentId,
    cwd = null,
    modelId = null,
  }: {
    agentId: string;
    cwd?: string | null;
    modelId?: string | null;
  }): Promise<RuntimeSessionMeta> {
    const definition = requireAgent(agentId);
    const client = await getClient(definition.id);
    const created = await client.newSession({
      ...(cwd ? { cwd } : {}),
      ...(modelId ? { modelId } : {}),
    });
    const nowIso = new Date().toISOString();
    const threadMeta = store.createSession({
      id: `${definition.id}:${randomUUID()}`,
      provider: definition.id,
      providerSessionId: created.sessionId,
      cwd,
      model: modelId,
      metadata: {
        acp: {
          adapterCommand: definition.command,
          initializeMeta: created._meta || null,
        },
      },
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    sessionRuntimeIndex.upsert({
      sessionId: threadMeta.id,
      provider: threadMeta.provider,
      providerSessionId: created.sessionId,
      engineSessionId: created.sessionId,
      cwd,
      model: modelId,
      ownerState: "idle",
      activeTurnId: null,
      updatedAt: nowIso,
    });
    return threadMeta;
  }

  function getSessionMeta(sessionId: string): RuntimeSessionMeta | null {
    return store.getSessionMeta(sessionId);
  }

  function listSessions(params: { archived?: boolean } = {}): RuntimeSessionMeta[] {
    const archived = Boolean(params.archived);
    return store.listSessionMetas()
      .filter((entry) => Boolean(entry.archived) === archived)
      .filter((entry) => registry.get(entry.provider) != null);
  }

  function shutdown(): void {
    initializedAgents.clear();
    for (const client of clients.values()) {
      client.close();
    }
    clients.clear();
  }

  function requireAgent(agentId: string): AcpAgentDefinition {
    const definition = registry.get(agentId);
    if (!definition) {
      throw new Error(`Unsupported ACP agent: ${agentId}`);
    }
    return definition;
  }

  return {
    createSession,
    getClient,
    getSessionMeta,
    listSessions,
    shutdown,
  };
}
