/*
 * An execution context as the runtime hands one to a request, for a test that
 * calls the worker from Node. It keeps whatever is handed to waitUntil, and
 * whether that has settled, so a test can say what a request left to run past
 * its answer, and wait for it.
 */
type Handed = { work: Promise<unknown>, settled: boolean };

function executionContext(): { context: ExecutionContext, handed: Handed[] } {
  const handed: Handed[] = [];
  const context = {
    waitUntil: (work: Promise<unknown>) => {
      const entry = { work, settled: false };
      work.then(() => { entry.settled = true; }, () => { entry.settled = true; });
      handed.push(entry);
    },
    passThroughOnException: () => {},
  };
  // workers-types 4.x declares more members, none of which the worker reads
  return { context: context as unknown as ExecutionContext, handed };
}

/*
 * Whether `work` settles within `milliseconds`. An answer that waits for work
 * a test holds back then fails the test rather than hanging it.
 */
async function settledWithin(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); });
  try {
    return await Promise.race([ work.then(() => true, () => true), late ]);
  } finally {
    clearTimeout(timer);
  }
}

export type { Handed };
export { executionContext, settledWithin };
