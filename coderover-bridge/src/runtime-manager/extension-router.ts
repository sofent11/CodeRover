// FILE: runtime-manager/extension-router.ts
// Purpose: Handles CodeRover-specific `_coderover/*` runtime extensions around the ACP core.

import type { JsonRpcId } from "../bridge-types";

type UnknownRecord = Record<string, unknown>;

export const RUNTIME_EXTENSION_METHODS = [
  "_coderover/agent/list",
  "_coderover/model/list",
  "_coderover/session/set_title",
  "_coderover/session/archive",
  "_coderover/session/unarchive",
  "_coderover/skills/list",
  "_coderover/fuzzy_file_search",
] as const;

export function isRuntimeExtensionMethod(method: string): boolean {
  return (RUNTIME_EXTENSION_METHODS as readonly string[]).includes(method);
}

export interface RuntimeExtensionRouterContext {
  handleRequestWithResponse(
    requestId: JsonRpcId | undefined,
    handler: () => Promise<unknown>
  ): Promise<boolean>;
  handleAgentList(): Promise<unknown>;
  handleModelList(params: UnknownRecord): Promise<unknown>;
  handleSessionSetTitle(params: UnknownRecord): Promise<unknown>;
  handleSessionArchive(params: UnknownRecord, archived: boolean): Promise<unknown>;
  unsupportedExtension(method: string): never;
}

export async function handleRuntimeExtensionMethod(
  method: string,
  requestId: JsonRpcId | undefined,
  params: UnknownRecord,
  context: RuntimeExtensionRouterContext
): Promise<boolean> {
  switch (method) {
    case "_coderover/agent/list":
      return await context.handleRequestWithResponse(requestId, async () => {
        return await context.handleAgentList();
      });

    case "_coderover/model/list":
      return await context.handleRequestWithResponse(requestId, async () => {
        return await context.handleModelList(params);
      });

    case "_coderover/session/set_title":
      return await context.handleRequestWithResponse(requestId, async () => {
        return await context.handleSessionSetTitle(params);
      });

    case "_coderover/session/archive":
      return await context.handleRequestWithResponse(requestId, async () => {
        return await context.handleSessionArchive(params, true);
      });

    case "_coderover/session/unarchive":
      return await context.handleRequestWithResponse(requestId, async () => {
        return await context.handleSessionArchive(params, false);
      });

    case "_coderover/skills/list":
    case "_coderover/fuzzy_file_search":
      context.unsupportedExtension(method);
      return true;

    default:
      return false;
  }
}
