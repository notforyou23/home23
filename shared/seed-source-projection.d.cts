export type SeedSourceProjectionEvent = Record<string, unknown> & { event_id: string };
/** newUnique is only for a fresh event's first attempt; retained retries must omit it. */
export function appendSeedProjectionOnce(eventsPath: string, event: SeedSourceProjectionEvent, options?: { newUnique?: boolean }): void;
