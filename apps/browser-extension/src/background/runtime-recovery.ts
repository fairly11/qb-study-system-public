export interface BoundedRecoveryOptions {
  readonly delayMilliseconds: number;
  readonly maxAttempts: number;
  readonly schedule: (callback: () => void, delayMilliseconds: number) => unknown;
}

export function createBoundedRecovery(
  operation: () => Promise<boolean>,
  options: BoundedRecoveryOptions,
): () => void {
  let queued = false;
  let remainingAttempts = 0;

  const enqueue = (): void => {
    if (queued || remainingAttempts <= 0) {
      return;
    }
    queued = true;
    try {
      options.schedule(() => {
        queued = false;
        remainingAttempts -= 1;
        void operation().then(
          (recovered) => {
            if (!recovered) {
              enqueue();
            }
          },
          () => enqueue(),
        );
      }, options.delayMilliseconds);
    } catch {
      queued = false;
    }
  };

  return (): void => {
    remainingAttempts = options.maxAttempts;
    enqueue();
  };
}
