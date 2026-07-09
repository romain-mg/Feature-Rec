// The DB transition is the source of truth; GitHub/Slack side effects run after
// it. Bounded retry narrows the window where a transient API failure leaves an
// external artifact out of sync with a cycle the DB already settled.
//
// Only wrap idempotent calls: check-run PATCHes and Slack chat.update are safe
// to repeat; comment POSTs are NOT (a retry after a post-write timeout posts a
// duplicate PR comment) — leave those single-shot.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 200): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
