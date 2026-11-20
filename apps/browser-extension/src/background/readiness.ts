export function createRetryableReadiness(
  initialize: () => Promise<boolean>,
): () => Promise<boolean> {
  let readiness: Promise<boolean> | undefined;

  return (): Promise<boolean> => {
    if (readiness !== undefined) {
      return readiness;
    }

    const attempt = initialize().catch(() => false);
    readiness = attempt;
    void attempt.then((ready) => {
      if (!ready && readiness === attempt) {
        readiness = undefined;
      }
    });
    return attempt;
  };
}
