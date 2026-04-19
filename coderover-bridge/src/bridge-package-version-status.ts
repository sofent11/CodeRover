// FILE: bridge-package-version-status.ts
// Purpose: Reads the installed CodeRover bridge package version and caches the latest published npm version.

import * as fs from "fs";
import * as https from "https";
import * as path from "path";

const installedVersion = readInstalledBridgeVersion();

const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_EMPTY_CACHE_RETRY_MS = 60 * 1000;
const DEFAULT_INITIAL_FETCH_WAIT_MS = 250;
const CODEROVER_REGISTRY_URL = "https://registry.npmjs.org/coderover/latest";

interface BridgePackageVersionStatusReaderOptions {
  cacheTtlMs?: number;
  emptyCacheRetryMs?: number;
  initialFetchWaitMs?: number;
  registryUrl?: string;
  fetchLatestPublishedVersionImpl?: (registryUrl: string) => Promise<string>;
}

export interface BridgePackageVersionStatus {
  bridgeVersion: string | null;
  bridgeLatestVersion: string | null;
}

export function readInstalledBridgeVersion(baseDir: string = __dirname): string {
  for (const relativePath of ["../package.json", "../../package.json"]) {
    const candidatePath = path.resolve(baseDir, relativePath);
    const packageVersion = readVersionFromPackageJson(candidatePath);
    if (packageVersion) {
      return packageVersion;
    }
  }

  return "";
}

export function createBridgePackageVersionStatusReader({
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  emptyCacheRetryMs = DEFAULT_EMPTY_CACHE_RETRY_MS,
  initialFetchWaitMs = DEFAULT_INITIAL_FETCH_WAIT_MS,
  registryUrl = CODEROVER_REGISTRY_URL,
  fetchLatestPublishedVersionImpl = fetchLatestPublishedVersion,
}: BridgePackageVersionStatusReaderOptions = {}): () => Promise<BridgePackageVersionStatus> {
  let cachedLatestVersion = "";
  let lastSuccessfulResolveAt = 0;
  let lastAttemptedAt = 0;
  let inFlightPromise: Promise<string> | null = null;

  return async function readBridgePackageVersionStatus(): Promise<BridgePackageVersionStatus> {
    const now = Date.now();
    refreshLatestVersionInBackground({
      now,
      cacheTtlMs,
      emptyCacheRetryMs,
      registryUrl,
      fetchLatestPublishedVersionImpl,
      getCachedLatestVersion: () => cachedLatestVersion,
      getLastSuccessfulResolveAt: () => lastSuccessfulResolveAt,
      getLastAttemptedAt: () => lastAttemptedAt,
      getInFlightPromise: () => inFlightPromise,
      setLastAttemptedAt: (value) => {
        lastAttemptedAt = value;
      },
      setInFlightPromise: (value) => {
        inFlightPromise = value;
      },
      setCachedLatestVersion: (value) => {
        cachedLatestVersion = value;
      },
      setLastSuccessfulResolveAt: (value) => {
        lastSuccessfulResolveAt = value;
      },
    });

    const reportedLatestVersion = await resolveReportedLatestVersion({
      initialFetchWaitMs,
      getCachedLatestVersion: () => cachedLatestVersion,
      getInFlightPromise: () => inFlightPromise,
    });

    return {
      bridgeVersion: normalizeVersion(installedVersion) || null,
      bridgeLatestVersion: reportedLatestVersion || null,
    };
  };
}

async function resolveReportedLatestVersion({
  initialFetchWaitMs,
  getCachedLatestVersion,
  getInFlightPromise,
}: {
  initialFetchWaitMs: number;
  getCachedLatestVersion: () => string;
  getInFlightPromise: () => Promise<string> | null;
}): Promise<string> {
  const cachedLatestVersion = getCachedLatestVersion();
  if (cachedLatestVersion) {
    return cachedLatestVersion;
  }

  const inFlightPromise = getInFlightPromise();
  if (!inFlightPromise || initialFetchWaitMs <= 0) {
    return "";
  }

  const latestVersion = await Promise.race([
    inFlightPromise.catch(() => ""),
    delay(initialFetchWaitMs).then(() => ""),
  ]);

  return latestVersion || getCachedLatestVersion();
}

function refreshLatestVersionInBackground({
  now,
  cacheTtlMs,
  emptyCacheRetryMs,
  registryUrl,
  fetchLatestPublishedVersionImpl,
  getCachedLatestVersion,
  getLastSuccessfulResolveAt,
  getLastAttemptedAt,
  getInFlightPromise,
  setLastAttemptedAt,
  setInFlightPromise,
  setCachedLatestVersion,
  setLastSuccessfulResolveAt,
}: {
  now: number;
  cacheTtlMs: number;
  emptyCacheRetryMs: number;
  registryUrl: string;
  fetchLatestPublishedVersionImpl: (registryUrl: string) => Promise<string>;
  getCachedLatestVersion: () => string;
  getLastSuccessfulResolveAt: () => number;
  getLastAttemptedAt: () => number;
  getInFlightPromise: () => Promise<string> | null;
  setLastAttemptedAt: (value: number) => void;
  setInFlightPromise: (value: Promise<string> | null) => void;
  setCachedLatestVersion: (value: string) => void;
  setLastSuccessfulResolveAt: (value: number) => void;
}): void {
  if (getInFlightPromise()) {
    return;
  }

  const cachedLatestVersion = getCachedLatestVersion();
  const isCacheFresh = cachedLatestVersion && now - getLastSuccessfulResolveAt() < cacheTtlMs;
  const retryWindowMs = cachedLatestVersion ? cacheTtlMs : emptyCacheRetryMs;
  const recentlyAttempted = now - getLastAttemptedAt() < retryWindowMs;

  if (isCacheFresh || recentlyAttempted) {
    return;
  }

  setLastAttemptedAt(now);
  setInFlightPromise(
    fetchLatestPublishedVersionImpl(registryUrl)
      .then((latestVersion) => {
        setCachedLatestVersion(latestVersion);
        setLastSuccessfulResolveAt(Date.now());
        return latestVersion;
      })
      .catch(() => getCachedLatestVersion())
      .finally(() => {
        setInFlightPromise(null);
      })
  );
}

function fetchLatestPublishedVersion(registryUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(registryUrl, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Unexpected npm registry status: ${response.statusCode || "unknown"}`));
        return;
      }

      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(raw) as { version?: unknown };
          const latestVersion = normalizeVersion(parsed?.version);
          if (!latestVersion) {
            reject(new Error("npm registry response missing version"));
            return;
          }
          resolve(latestVersion);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(4_000, () => {
      request.destroy(new Error("npm registry request timed out"));
    });
    request.on("error", reject);
  });
}

function normalizeVersion(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function readVersionFromPackageJson(packageJsonPath: string): string {
  if (!fs.existsSync(packageJsonPath)) {
    return "";
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return normalizeVersion(parsed?.version);
  } catch {
    return "";
  }
}
