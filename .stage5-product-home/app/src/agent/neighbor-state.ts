/**
 * neighbor-state — builds each agent's public state surface for peers.
 *
 * Served at GET /__state/public.json by the dashboard. Each peer agent
 * polls this endpoint via NeighborChannel and ingests observations as
 * UNCERTIFIED bus signals (the state is second-hand by construction).
 *
 * Shape is intentionally minimal: active goals (sparse), last N verified
 * observations, current focus text, dispatch state, last-memory-write
 * timestamp. No identity leak, no private thought graph access.
 *
 * See docs/design/STEP24-OS-ENGINE-REDESIGN.md §The Neighbor Protocol Extension.
 */

import type { VerifiedObservation } from './verification.js';

export interface PublicStateGoal {
  id: string;
  title: string;
  termination: unknown;
  ageMs: number;
}

export interface PublicState {
  agent: string;
  origin: {
    agent: string;
    protocol: 'home23-neighbor-state';
    protocolVersion: number;
  };
  activeGoals: PublicStateGoal[];
  recentObservations: VerifiedObservation[];
  currentFocus: string;
  dispatchState: 'idle' | 'cognizing' | 'dispatched';
  lastMemoryWrite: string;
  snapshotAt: string;
}

export interface PublicStateDeps {
  agent: string;
  getActiveGoals: () => PublicStateGoal[];
  getRecentObservations: (n: number) => VerifiedObservation[];
  getCurrentFocus: () => string;
  getDispatchState: () => PublicState['dispatchState'];
  getLastMemoryWrite: () => string;
}

export async function buildPublicState(
  deps: PublicStateDeps,
  { recentCount = 20 }: { recentCount?: number } = {},
): Promise<PublicState> {
  return {
    agent: deps.agent,
    origin: {
      agent: deps.agent,
      protocol: 'home23-neighbor-state',
      protocolVersion: 1,
    },
    activeGoals: deps.getActiveGoals(),
    recentObservations: deps.getRecentObservations(recentCount),
    currentFocus: deps.getCurrentFocus(),
    dispatchState: deps.getDispatchState(),
    lastMemoryWrite: deps.getLastMemoryWrite(),
    snapshotAt: new Date().toISOString(),
  };
}
