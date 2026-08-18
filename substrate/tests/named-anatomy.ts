/**
 * Explicit named body for tests that need a living seed.
 * Not a public birth default — birth without named anatomy must refuse.
 */
import type { AnatomyCellSpec } from '../src/types.js';
import { PRE_ANATOMY_GENESIS_FALLBACK } from '../src/types.js';

export const TEST_ANATOMY: readonly AnatomyCellSpec[] = PRE_ANATOMY_GENESIS_FALLBACK;
