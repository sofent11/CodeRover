// FILE: bridge-preferences.ts
// Purpose: Persists lightweight local bridge preferences shared with mobile clients.

import * as fs from "fs";
import * as path from "path";

import { resolveCoderoverHome } from "./bridge-daemon-state";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "./atomic-json-file";

export interface BridgePreferences {
  version: 1;
  keepAwakeEnabled: boolean;
}

export const DEFAULT_KEEP_AWAKE_ENABLED = true;

const BRIDGE_PREFERENCES_VERSION = 1;
const BRIDGE_PREFERENCES_FILE = "bridge-preferences.json";

export function resolveBridgePreferencesPath(): string {
  return path.join(resolveCoderoverHome(), BRIDGE_PREFERENCES_FILE);
}

export function readBridgePreferences(): BridgePreferences {
  const preferencesPath = resolveBridgePreferencesPath();
  if (!fs.existsSync(preferencesPath)) {
    return createDefaultBridgePreferences();
  }

  try {
    return normalizeBridgePreferences(readJsonFileWithBackup(preferencesPath));
  } catch {
    return createDefaultBridgePreferences();
  }
}

export function writeBridgePreferences(
  preferences: Partial<BridgePreferences> | BridgePreferences
): BridgePreferences {
  const normalized = normalizeBridgePreferences(preferences);
  const preferencesPath = resolveBridgePreferencesPath();
  writeJsonFileAtomic(preferencesPath, normalized);
  return normalized;
}

export function updateBridgePreferences(
  updates: Partial<BridgePreferences>
): BridgePreferences {
  return writeBridgePreferences({
    ...readBridgePreferences(),
    ...updates,
  });
}

export function createDefaultBridgePreferences(): BridgePreferences {
  return {
    version: BRIDGE_PREFERENCES_VERSION,
    keepAwakeEnabled: DEFAULT_KEEP_AWAKE_ENABLED,
  };
}

function normalizeBridgePreferences(rawValue: unknown): BridgePreferences {
  const record = rawValue && typeof rawValue === "object"
    ? rawValue as Record<string, unknown>
    : {};

  return {
    version: BRIDGE_PREFERENCES_VERSION,
    keepAwakeEnabled: typeof record.keepAwakeEnabled === "boolean"
      ? record.keepAwakeEnabled
      : DEFAULT_KEEP_AWAKE_ENABLED,
  };
}
