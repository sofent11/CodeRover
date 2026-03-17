// FILE: acp/session-manager.ts
// Purpose: Bridge-local ACP session coordination around logical agents and spawned ACP adapter clients.

import { randomUUID } from "crypto";

import type { RuntimeSessionMeta, RuntimeStore } from "../runtime-store";
import type { SessionRuntimeIndex } from "../runtime-engine/session-runtime-index";
import { ACP_PROTOCOL_VERSION } from "../runtime-engine/acp-protocol";
import type { AcpAgentDefinition, AcpAgentRegistry } from "./agent-registry";
import { createAcpProcessClient, type AcpProcessClient } from "./process-client";
import { debugError, debugLog } from "../debug-log";

type UnknownRecord = Record<string, unknown>;

const SESSION_LIST_BOOTSTRAP_MAX_PAGES = 200;
const SESSION_LIST_POLL_INTERVAL_MS = 30_000;
const SESSION_LIST_STALE_MS = 15_000;

export interface AcpSessionManager {
  createSession(params: {
    agentId: string;
    cwd?: string | null;
    modelId?: string | null;
  }): Promise<RuntimeSessionMeta>;
  ensureSessionCacheReady(params?: { archived?: boolean; force?: boolean }): Promise<void>;
  getClient(agentId: string): Promise<AcpProcessClient>;
  getSessionMeta(sessionId: string): RuntimeSessionMeta | null;
  listSessions(params?: { archived?: boolean }): RuntimeSessionMeta[];
  refreshSessions(params?: { archived?: boolean; force?: boolean }): Promise<void>;
  shutdown(): void;
}

export function createAcpSessionManager({
  registry,
  store,
  sessionRuntimeIndex,
  clientFactory = createAcpProcessClient,
  pollIntervalMs = SESSION_LIST_POLL_INTERVAL_MS,
}: {
  registry: AcpAgentRegistry;
  store: RuntimeStore;
  sessionRuntimeIndex: SessionRuntimeIndex;
  clientFactory?: (commandLine: string) => AcpProcessClient;
  pollIntervalMs?: number;
}): AcpSessionManager {
  const clients = new Map<string, AcpProcessClient>();
  const initializedAgents = new Set<string>();
  const bootstrappedScopes = new Set<string>();
  const bootstrapPromises = new Map<string, Promise<void>>();
  const refreshPromises = new Map<string, Promise<void>>();
  const lastRefreshAtByScope = new Map<string, number>();
  const sessionListUnsupportedProviders = new Set<string>();
  let pollTimer: NodeJS.Timeout | null = null;
  let isShuttingDown = false;

  void bootstrapScope(false);
  bootstrappedScopes.add(sessionListScopeKey(true));
  if (pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      void pollSessionCaches();
    }, pollIntervalMs);
    pollTimer.unref?.();
  }

  async function getClient(agentId: string): Promise<AcpProcessClient> {
    const definition = requireAgent(agentId);
    const existing = clients.get(definition.id);
    if (existing?.isRunning()) {
      await initializeClient(definition, existing);
      return existing;
    }

    existing?.close();
    const client = clientFactory(definition.command);
    clients.set(definition.id, client);
    await initializeClient(definition, client);
    return client;
  }

  async function initializeClient(definition: AcpAgentDefinition, client: AcpProcessClient): Promise<void> {
    if (initializedAgents.has(definition.id)) {
      return;
    }
    await client.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
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

  async function ensureSessionCacheReady(
    params: { archived?: boolean; force?: boolean } = {}
  ): Promise<void> {
    const archived = Boolean(params.archived);
    const providerSyncArchived = providerSessionListSyncScope(archived);
    const scopeKey = sessionListScopeKey(providerSyncArchived);
    const bootstrap = bootstrapPromises.get(scopeKey);
    if (bootstrap) {
      await bootstrap;
    } else if (!bootstrappedScopes.has(scopeKey)) {
      await bootstrapScope(providerSyncArchived);
    }

    const isStale = Boolean(params.force) || shouldRefreshScope(providerSyncArchived);
    if (!isStale) {
      return;
    }

    void scheduleScopeRefresh({
      archived: providerSyncArchived,
      force: Boolean(params.force),
      fullSync: false,
    });
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

  async function refreshSessions(params: { archived?: boolean; force?: boolean } = {}): Promise<void> {
    const archived = providerSessionListSyncScope(Boolean(params.archived));
    await scheduleScopeRefresh({
      archived,
      force: Boolean(params.force),
      fullSync: true,
    });
  }

  function shutdown(): void {
    isShuttingDown = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    initializedAgents.clear();
    for (const client of clients.values()) {
      client.close();
    }
    clients.clear();
  }

  async function bootstrapScope(archived: boolean): Promise<void> {
    const scopeKey = sessionListScopeKey(archived);
    const existing = bootstrapPromises.get(scopeKey);
    if (existing) {
      await existing;
      return;
    }

    let bootstrapPromise: Promise<void>;
    bootstrapPromise = scheduleScopeRefresh({
      archived,
      force: true,
      fullSync: true,
    }).catch((error) => {
      debugError(`[acp-session-manager] bootstrap ${scopeKey} failed: ${describeError(error)}`);
    }).finally(() => {
      bootstrappedScopes.add(scopeKey);
      if (bootstrapPromises.get(scopeKey) === bootstrapPromise) {
        bootstrapPromises.delete(scopeKey);
      }
    });

    bootstrapPromises.set(scopeKey, bootstrapPromise);
    await bootstrapPromise;
  }

  async function pollSessionCaches(): Promise<void> {
    await scheduleScopeRefresh({ archived: false, force: false, fullSync: false });
  }

  function shouldRefreshScope(archived: boolean): boolean {
    const scopeKey = sessionListScopeKey(archived);
    const lastRefreshAt = lastRefreshAtByScope.get(scopeKey) || 0;
    return Date.now() - lastRefreshAt >= SESSION_LIST_STALE_MS;
  }

  async function scheduleScopeRefresh({
    archived,
    force,
    fullSync,
  }: {
    archived: boolean;
    force: boolean;
    fullSync: boolean;
  }): Promise<void> {
    if (isShuttingDown) {
      return;
    }

    const scopeKey = sessionListScopeKey(archived);
    const existing = refreshPromises.get(scopeKey);
    if (existing) {
      await existing;
      return;
    }

    let promise: Promise<void>;
    promise = runScopeRefresh({ archived, force, fullSync })
      .finally(() => {
        lastRefreshAtByScope.set(scopeKey, Date.now());
        if (refreshPromises.get(scopeKey) === promise) {
          refreshPromises.delete(scopeKey);
        }
      });
    refreshPromises.set(scopeKey, promise);
    await promise;
  }

  async function runScopeRefresh({
    archived,
    force,
    fullSync,
  }: {
    archived: boolean;
    force: boolean;
    fullSync: boolean;
  }): Promise<void> {
    for (const definition of registry.list()) {
      try {
        await syncProviderSessions(definition, { archived, force, fullSync });
      } catch (error) {
        debugError(
          `[acp-session-manager] session/list sync failed provider=${definition.id} archived=${archived}: ${describeError(error)}`
        );
      }
    }
  }

  async function syncProviderSessions(
    definition: AcpAgentDefinition,
    {
      archived,
      force,
      fullSync,
    }: {
      archived: boolean;
      force: boolean;
      fullSync: boolean;
    }
  ): Promise<void> {
    if (sessionListUnsupportedProviders.has(definition.id)) {
      return;
    }

    const client = await getClient(definition.id);
    let nextCursor = force
      ? null
      : store.getProviderSessionListState(definition.id, archived).nextCursor;
    let pageCount = 0;

    do {
      let result: Record<string, unknown>;
      try {
        result = await client.listSessions({
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
      } catch (error) {
        if (isUnsupportedSessionListError(error)) {
          sessionListUnsupportedProviders.add(definition.id);
          debugLog(
            `[acp-session-manager] provider=${definition.id} does not support session/list; skipping future syncs`
          );
          return;
        }
        throw error;
      }
      const page = normalizeSessionListPage(result);
      const syncTimestamp = new Date().toISOString();

      for (const session of page.sessions) {
        upsertProviderSessionMeta(definition, session);
      }

      store.updateProviderSessionListState(definition.id, archived, () => ({
        provider: definition.id as RuntimeSessionMeta["provider"],
        archived,
        nextCursor: page.nextCursor,
        syncedAt: syncTimestamp,
      }));
      pageCount += 1;

      debugLog(
        `[acp-session-manager] session/list synced provider=${definition.id} archived=${archived} page=${pageCount} count=${page.sessions.length} nextCursor=${page.nextCursor || "null"}`
      );

      if (!fullSync) {
        return;
      }
      if (!page.nextCursor) {
        return;
      }
      if (page.nextCursor === nextCursor) {
        debugError(
          `[acp-session-manager] session/list cursor stalled provider=${definition.id} archived=${archived} cursor=${page.nextCursor}`
        );
        return;
      }

      nextCursor = page.nextCursor;
    } while (pageCount < SESSION_LIST_BOOTSTRAP_MAX_PAGES);
  }

  function upsertProviderSessionMeta(
    definition: AcpAgentDefinition,
    rawSession: UnknownRecord
  ): RuntimeSessionMeta | null {
    const providerSessionId = firstNonEmptyString([
      rawSession.sessionId,
      rawSession.id,
      asObject(asObject(rawSession._meta)?.coderover)?.providerSessionId,
    ]);
    if (!providerSessionId) {
      return null;
    }

    const existingSessionId = store.findSessionIdByProviderSession(definition.id, providerSessionId);
    const existing = existingSessionId ? store.getSessionMeta(existingSessionId) : null;
    const localSessionId = existing?.id || buildDiscoveredSessionId(definition.id, providerSessionId);
    const providerArchived = Boolean(
      rawSession.archived
      ?? asObject(asObject(rawSession._meta)?.coderover)?.archived
      ?? false
    );
    const title = firstNonEmptyString([
      rawSession.title,
      rawSession.name,
      rawSession.summary,
      rawSession.label,
    ]);
    const preview = firstNonEmptyString([
      asObject(asObject(rawSession._meta)?.coderover)?.preview,
      rawSession.preview,
      rawSession.summary,
      title,
      existing?.preview,
    ]);
    const cwd = firstNonEmptyPath([
      rawSession.cwd,
      asObject(asObject(rawSession._meta)?.coderover)?.cwd,
      existing?.cwd,
    ]);
    const model = firstNonEmptyString([
      rawSession.modelId,
      rawSession.model,
      asObject(rawSession.models)?.currentModelId,
      existing?.model,
    ]);
    const updatedAt = firstNonEmptyString([
      rawSession.updatedAt,
      rawSession.updated_at,
      rawSession.lastUpdatedAt,
      rawSession.last_updated_at,
      rawSession.createdAt,
      rawSession.created_at,
      existing?.updatedAt,
      new Date().toISOString(),
    ]);
    const createdAt = firstNonEmptyString([
      rawSession.createdAt,
      rawSession.created_at,
      rawSession.updatedAt,
      rawSession.updated_at,
      existing?.createdAt,
      updatedAt,
    ]);
    const metadata = buildSessionMetadata(existing, definition);
    const capabilities = existing?.capabilities || cloneRecord(definition.supports);
    const nextMeta = store.upsertSessionMeta({
      ...(existing || {}),
      id: localSessionId,
      provider: definition.id,
      providerSessionId,
      title: title || existing?.title,
      name: existing?.name || null,
      preview,
      cwd,
      model,
      metadata,
      capabilities,
      createdAt,
      updatedAt,
      archived: Boolean(existing?.archived || providerArchived),
    });

    sessionRuntimeIndex.upsert({
      ...(sessionRuntimeIndex.get(nextMeta.id) || {
        sessionId: nextMeta.id,
        provider: nextMeta.provider,
        createdAt: nextMeta.createdAt,
      }),
      sessionId: nextMeta.id,
      provider: nextMeta.provider,
      providerSessionId: nextMeta.providerSessionId,
      engineSessionId: nextMeta.providerSessionId || nextMeta.id,
      cwd: nextMeta.cwd,
      model: nextMeta.model,
      ownerState: sessionRuntimeIndex.get(nextMeta.id)?.ownerState || "idle",
      activeTurnId: sessionRuntimeIndex.get(nextMeta.id)?.activeTurnId || null,
      updatedAt: nextMeta.updatedAt,
    });

    return nextMeta;
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
    ensureSessionCacheReady,
    getClient,
    getSessionMeta,
    listSessions,
    refreshSessions,
    shutdown,
  };
}

function normalizeSessionListPage(result: unknown): {
  sessions: UnknownRecord[];
  nextCursor: string | null;
} {
  const record = asObject(result);
  const sessions = firstArrayOfObjects([
    record?.sessions,
    record?.items,
    record?.data,
  ]);
  return {
    sessions,
    nextCursor: firstNonEmptyString([
      record?.nextCursor,
      record?.next_cursor,
    ]),
  };
}

function buildDiscoveredSessionId(provider: string, providerSessionId: string): string {
  if (provider === "codex" && /^[0-9a-f-]{36}$/i.test(providerSessionId)) {
    return providerSessionId;
  }
  return `${provider}:${randomUUID()}`;
}

function buildSessionMetadata(
  existing: RuntimeSessionMeta | null,
  definition: AcpAgentDefinition
): UnknownRecord | null {
  const existingMetadata = cloneRecord(existing?.metadata);
  const acpMetadata = cloneRecord(existingMetadata?.acp);
  return {
    ...(existingMetadata || {}),
    acp: {
      ...(acpMetadata || {}),
      adapterCommand: definition.command,
    },
  };
}

function cloneRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as UnknownRecord) }
    : null;
}

function asObject(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function firstArrayOfObjects(values: unknown[]): UnknownRecord[] {
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    return value
      .filter((entry): entry is UnknownRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => ({ ...entry }));
  }
  return [];
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstNonEmptyPath(values: unknown[]): string | null {
  return firstNonEmptyString(values);
}

function sessionListScopeKey(archived: boolean): string {
  return archived ? "archived" : "active";
}

function providerSessionListSyncScope(_archived: boolean): boolean {
  return false;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isUnsupportedSessionListError(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return message.includes("method not found") || message.includes("unsupported method");
}
