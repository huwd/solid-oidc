export type CheckHealthOptions = {
  readonly timeoutMs: number;
  readonly url: URL;
};

/**
 * Report whether the server answers its health endpoint with a success status
 * within the timeout. Any network failure or timeout counts as unhealthy.
 */
export async function checkHealth(options: CheckHealthOptions): Promise<boolean> {
  try {
    const response = await fetch(options.url, {
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    // The caller only needs healthy or unhealthy; the reason is not actionable
    // inside a container healthcheck, whose output Docker discards.
    return false;
  }
}
