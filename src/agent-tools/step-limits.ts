/**
 * Turn-loop pacing for the client-driven agent loop (model → tool → model).
 *
 * A cap is still required — a confused model can loop forever — but it has to be
 * high enough for real multi-step work. A single Printify product takes five
 * steps before the user even sees a confirm card (resolve blueprint → print
 * provider → variants → propose), so the old cap of 6 dead-ended legitimate
 * turns mid-task. Hitting the cap is now a pause, not a failure: the caller
 * keeps the history and offers a Continue affordance.
 */
export const MAX_TURN_STEPS = 30;

/**
 * A stuck model can call the same tool with the same arguments forever, which a
 * step cap alone cannot tell apart from genuine progress. After this many
 * identical calls in one turn the loop stops early and says why.
 */
export const MAX_IDENTICAL_CALLS = 3;

/** Identity of a tool call for no-progress detection. */
export function callSignature(name: string, args: string): string {
  return `${name}(${args.trim()})`;
}

export interface CallTracker {
  /** Counts one call and returns how many times that exact call has been seen. */
  record(name: string, args: string): number;
  /** How many times that exact call has been seen so far. */
  count(name: string, args: string): number;
}

export function createCallTracker(): CallTracker {
  const seen = new Map<string, number>();
  const count = (name: string, args: string) => seen.get(callSignature(name, args)) ?? 0;
  return {
    count,
    record(name, args) {
      const signature = callSignature(name, args);
      const next = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, next);
      return next;
    },
  };
}
