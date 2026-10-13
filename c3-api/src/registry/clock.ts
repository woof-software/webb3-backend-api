/*
 * The registry's injectable clock, so a lease, a retry, the age of a cached
 * answer or the expiry of an exception can be tested without waiting for
 * real time to pass.
 */
type Clock = () => Date;

// the time by the clock a caller injected, or by the wall clock where it injected none
function nowOf(clock: Clock | undefined): Date {
  return clock?.() ?? new Date();
}

export type { Clock };
export { nowOf };
