/**
 * Migration 001: Initial baseline
 *
 * Ensures all plumbing from pre-migration era is in place.
 * This is a no-op if ensureSystemHealth() already handled everything,
 * but it establishes the migration tracking baseline.
 */

export const description = 'Baseline — establish migration tracking';

export async function up(home23Root) {
  console.log('    Baseline migration applied');
}
