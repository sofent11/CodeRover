// FILE: runtime-manager/client-routing.ts
// Purpose: Typed request/response plumbing helpers for runtime-manager.

import type { JsonRpcId } from "../bridge-types";
import type { RuntimeErrorShape, RuntimeInitializeParams } from "./types";

export function defaultInitializeParams(): RuntimeInitializeParams {
  return {
    clientInfo: {
      name: "coderover_bridge",
      title: "Codex Bridge",
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

export function createRuntimeError(code: number, message: string): RuntimeErrorShape {
  const error = new Error(message) as RuntimeErrorShape;
  error.code = code;
  return error;
}

export function createMethodError(code: number, message: string): RuntimeErrorShape {
  return createRuntimeError(code, message);
}

export function encodeRequestId(value: JsonRpcId | undefined): string {
  if (value == null) {
    return "";
  }
  return JSON.stringify(value);
}
