type ShutdownHandler = (exitCode: number) => Promise<void>;

export function createShutdownCoordinator(initialHandler: ShutdownHandler) {
  let handler = initialHandler;
  let shutdownPromise: null | Promise<void> = null;

  return {
    configure(nextHandler: ShutdownHandler): void {
      handler = nextHandler;
    },
    isShuttingDown(): boolean {
      return shutdownPromise !== null;
    },
    request(exitCode = 0): Promise<void> {
      shutdownPromise ??= handler(exitCode);
      return shutdownPromise;
    },
  };
}

const coordinator = createShutdownCoordinator(async (exitCode) => {
  process.exitCode = exitCode;
});

export const configureShutdown = coordinator.configure;
export const isShuttingDown = coordinator.isShuttingDown;
export function requestShutdown(exitCode = 0): Promise<void> {
  return coordinator.request(exitCode).catch((error: unknown) => {
    process.stderr.write(
      `[ShadowAuditor] Shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = exitCode || 1;
  });
}
