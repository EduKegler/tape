export const retryDelay = (failureCount: number) => Math.min(1000 * 2 ** failureCount, 30_000)
