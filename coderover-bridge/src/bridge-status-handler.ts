// FILE: bridge-status-handler.ts
// Purpose: Exposes bridge version, compatibility, and preference state to local mobile clients.

import {
  readBridgePreferences,
  updateBridgePreferences,
  type BridgePreferences,
} from "./bridge-preferences";
import { createBridgePackageVersionStatusReader } from "./bridge-package-version-status";
import type { TransportCandidateShape } from "./bridge-types";

type SendResponse = (response: string) => void;
type JsonObject = Record<string, unknown>;

interface BridgeRequest extends JsonObject {
  method?: unknown;
  id?: unknown;
  params?: unknown;
}

interface BridgeStatusHandlerOptions {
  readPackageVersionStatus?: () => Promise<{
    bridgeVersion: string | null;
    bridgeLatestVersion: string | null;
  }>;
  getPreferences?: () => BridgePreferences;
  updatePreferences?: (updates: Partial<BridgePreferences>) => BridgePreferences;
  getTrustedDeviceCount?: () => number;
  getKeepAwakeActive?: () => boolean;
  getTransportCandidates?: () => TransportCandidateShape[];
  getObservability?: () => unknown;
  upgradeCommand?: string;
  minimumSupportedIOSVersion?: string;
  minimumSupportedAndroidVersion?: string;
}

const DEFAULT_UPGRADE_COMMAND = "bun add -g coderover@latest";
const DEFAULT_MINIMUM_SUPPORTED_IOS_VERSION = "1.0";
const DEFAULT_MINIMUM_SUPPORTED_ANDROID_VERSION = "0.1.0";

export function createBridgeStatusHandler({
  readPackageVersionStatus = createBridgePackageVersionStatusReader(),
  getPreferences = readBridgePreferences,
  updatePreferences = updateBridgePreferences,
  getTrustedDeviceCount = () => 0,
  getKeepAwakeActive = () => false,
  getTransportCandidates = () => [],
  getObservability = () => ({}),
  upgradeCommand = DEFAULT_UPGRADE_COMMAND,
  minimumSupportedIOSVersion = DEFAULT_MINIMUM_SUPPORTED_IOS_VERSION,
  minimumSupportedAndroidVersion = DEFAULT_MINIMUM_SUPPORTED_ANDROID_VERSION,
}: BridgeStatusHandlerOptions = {}): (rawMessage: string, sendResponse: SendResponse) => boolean {
  return function handleBridgeStatusRequest(rawMessage: string, sendResponse: SendResponse): boolean {
    const parsed = parseBridgeRequest(rawMessage);
    if (!parsed) {
      return false;
    }

    const method = readNonEmptyString(parsed.method);
    if (!method || !method.startsWith("bridge/")) {
      return false;
    }

    const id = parsed.id;
    const params = asObject(parsed.params);

    void handleBridgeMethod(method, params, {
      readPackageVersionStatus,
      getPreferences,
      updatePreferences,
      getTrustedDeviceCount,
      getKeepAwakeActive,
      getTransportCandidates,
      getObservability,
      upgradeCommand,
      minimumSupportedIOSVersion,
      minimumSupportedAndroidVersion,
    })
      .then((result) => {
        sendResponse(JSON.stringify({ id, result }));
      })
      .catch((error: Error & { errorCode?: string }) => {
        sendResponse(JSON.stringify({
          id,
          error: {
            code: -32000,
            message: error.message || "Unknown bridge status error",
            data: {
              errorCode: error.errorCode || "bridge_status_error",
            },
          },
        }));
      });

    return true;
  };
}

async function handleBridgeMethod(
  method: string,
  params: JsonObject | null,
  options: Required<BridgeStatusHandlerOptions>
): Promise<JsonObject> {
  switch (method) {
    case "bridge/status/read":
      return buildBridgeStatusPayload(options);
    case "bridge/updatePrompt/read":
      return buildBridgeUpdatePromptPayload(options);
    case "bridge/preferences/update":
      return updateBridgePreferencesPayload(params, options);
    default:
      throw bridgeStatusError("unknown_method", `Unknown bridge method: ${method}`);
  }
}

async function buildBridgeStatusPayload(
  options: Required<BridgeStatusHandlerOptions>
): Promise<JsonObject> {
  const versionStatus = await options.readPackageVersionStatus();
  const preferences = options.getPreferences();
  const updateAvailable = isVersionNewer(
    versionStatus.bridgeLatestVersion,
    versionStatus.bridgeVersion
  );
  const transportCandidates = options.getTransportCandidates()
    .map((candidate) => normalizeTransportCandidate(candidate))
    .filter((candidate): candidate is TransportCandidateShape => candidate != null);

  return {
    bridgeVersion: versionStatus.bridgeVersion,
    bridgeLatestVersion: versionStatus.bridgeLatestVersion,
    updateAvailable,
    upgradeCommand: options.upgradeCommand,
    preferences: {
      keepAwakeEnabled: preferences.keepAwakeEnabled,
    },
    keepAwakeEnabled: preferences.keepAwakeEnabled,
    keepAwakeActive: options.getKeepAwakeActive(),
    trustedDeviceCount: options.getTrustedDeviceCount(),
    trustedDeviceStatus: options.getTrustedDeviceCount() > 0 ? "trusted" : "unpaired",
    supportedMobileVersions: {
      ios: {
        minimumVersion: options.minimumSupportedIOSVersion,
        maximumVersion: null,
        recommendedVersion: options.minimumSupportedIOSVersion,
      },
      android: {
        minimumVersion: options.minimumSupportedAndroidVersion,
        maximumVersion: null,
        recommendedVersion: options.minimumSupportedAndroidVersion,
      },
    },
    transportCandidates,
    observability: asObject(options.getObservability()) || {},
  };
}

async function buildBridgeUpdatePromptPayload(
  options: Required<BridgeStatusHandlerOptions>
): Promise<JsonObject> {
  const status = await buildBridgeStatusPayload(options);
  const installedVersion = readNonEmptyString(status.bridgeVersion);
  const latestVersion = readNonEmptyString(status.bridgeLatestVersion);
  const shouldPrompt = status.updateAvailable === true && installedVersion && latestVersion;

  if (!shouldPrompt) {
    return {
      shouldPrompt: false,
      kind: "none",
    };
  }

  return {
    shouldPrompt: true,
    kind: "bridge_update_available",
    title: "Update the CodeRover bridge",
    message: `Bridge ${installedVersion} is installed on this Mac. Version ${latestVersion} is available.`,
    bridgeVersion: installedVersion,
    bridgeLatestVersion: latestVersion,
    upgradeCommand: options.upgradeCommand,
  };
}

async function updateBridgePreferencesPayload(
  params: JsonObject | null,
  options: Required<BridgeStatusHandlerOptions>
): Promise<JsonObject> {
  const preferencesObject = asObject(params?.preferences) || params;
  const keepAwakeEnabled = readBoolean(preferencesObject?.keepAwakeEnabled);

  if (keepAwakeEnabled == null) {
    throw bridgeStatusError(
      "invalid_preferences",
      "A keepAwakeEnabled preference is required."
    );
  }

  const updatedPreferences = options.updatePreferences({ keepAwakeEnabled });
  return {
    success: true,
    preferences: updatedPreferences,
    keepAwakeEnabled: updatedPreferences.keepAwakeEnabled,
    keepAwakeActive: options.getKeepAwakeActive(),
  };
}

function parseBridgeRequest(rawMessage: string): BridgeRequest | null {
  try {
    return JSON.parse(rawMessage) as BridgeRequest;
  } catch {
    return null;
  }
}

function bridgeStatusError(errorCode: string, message: string): Error & { errorCode: string } {
  const error = new Error(message) as Error & { errorCode: string };
  error.errorCode = errorCode;
  return error;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeTransportCandidate(candidate: unknown): TransportCandidateShape | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const kind = readNonEmptyString(record.kind);
  const url = readNonEmptyString(record.url);
  if (!kind || !url) {
    return null;
  }

  return {
    kind,
    url,
    label: readNonEmptyString(record.label),
  };
}

function isVersionNewer(candidateVersion: string | null, currentVersion: string | null): boolean {
  if (!candidateVersion || !currentVersion) {
    return false;
  }
  return compareSemverish(candidateVersion, currentVersion) > 0;
}

function compareSemverish(left: string, right: string): number {
  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return 0;
}

function normalizeVersionParts(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part.replace(/[^\d].*$/, ""), 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}
