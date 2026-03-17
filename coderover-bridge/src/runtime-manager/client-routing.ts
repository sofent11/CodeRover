// FILE: runtime-manager/client-routing.ts
// Purpose: Typed request/response plumbing helpers for runtime-manager.

import type { JsonRpcId } from "../bridge-types";
import type { RuntimeErrorShape } from "./types";

export function createRuntimeError(code: number, message: string): RuntimeErrorShape {
  const error = new Error(message) as RuntimeErrorShape;
  error.code = code;
  return error;
}

export function encodeRequestId(value: JsonRpcId | undefined): string {
  if (value == null) {
    return "";
  }
  return JSON.stringify(value);
}
