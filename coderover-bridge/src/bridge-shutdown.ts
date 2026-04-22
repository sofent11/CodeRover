// FILE: bridge-shutdown.ts
// Purpose: Coordinates async bridge shutdown tasks with a timeout guard.

export interface BridgeShutdownTask {
  label: string;
  run(): Promise<void> | void;
}

export interface BridgeShutdownResult {
  timedOut: boolean;
  completedLabels: string[];
}

export async function runBridgeShutdownTasks(
  tasks: BridgeShutdownTask[],
  {
    timeoutMs = 2_000,
    onTimeout,
  }: {
    timeoutMs?: number;
    onTimeout?: (pendingLabels: string[]) => void;
  } = {}
): Promise<BridgeShutdownResult> {
  const completedLabels: string[] = [];
  const pendingLabels = new Set(tasks.map((task) => task.label));

  const runner = Promise.allSettled(tasks.map(async (task) => {
    await task.run();
    completedLabels.push(task.label);
    pendingLabels.delete(task.label);
  }));

  if (timeoutMs <= 0) {
    await runner;
    return {
      timedOut: false,
      completedLabels,
    };
  }

  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutResult = new Promise<BridgeShutdownResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      onTimeout?.([...pendingLabels]);
      resolve({
        timedOut: true,
        completedLabels: [...completedLabels],
      });
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  const settledResult = await Promise.race([
    runner.then(() => ({
      timedOut: false,
      completedLabels: [...completedLabels],
    })),
    timeoutResult,
  ]);

  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  return settledResult;
}
