/**
 * Types for the lifecycle catalog. The unions here must list exactly the
 * states in shared/lifecycles.cjs; tests/shared/lifecycles.test.ts fails when
 * the two disagree.
 */

export type ChatTurnTerminalStatus = 'complete' | 'stopped' | 'error' | 'timeout' | 'orphaned';
/** What the conversation journal stores. */
export type ChatTurnStoredStatus = 'pending' | ChatTurnTerminalStatus;
/** What a still-pending turn is reported as. Derived at read time; never stored. */
export type ChatTurnViewStatus =
  | 'accepted' | 'running' | 'awaiting_model' | 'streaming' | 'tool_running' | 'stopping';
export type ChatTurnStatus = ChatTurnStoredStatus | ChatTurnViewStatus;

export type AsyncWorkTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AsyncWorkLifecycleStatus = 'queued' | 'running' | 'blocked' | AsyncWorkTerminalStatus;

export type CodingJobTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type CodingJobLifecycleStatus = 'starting' | 'running' | CodingJobTerminalStatus;

export type WorkVerificationTerminalStatus = 'reviewed' | 'skipped';
export type WorkVerificationLifecycleStatus = 'none' | 'pending' | WorkVerificationTerminalStatus;

export type BrainOperationTerminalState = 'complete' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type BrainOperationLifecycleState = 'queued' | 'running' | BrainOperationTerminalState;

export interface LifecycleStates {
  'chat-turn': { state: ChatTurnStoredStatus; terminal: ChatTurnTerminalStatus; view: ChatTurnViewStatus };
  'async-work': { state: AsyncWorkLifecycleStatus; terminal: AsyncWorkTerminalStatus; view: never };
  'coding-job': { state: CodingJobLifecycleStatus; terminal: CodingJobTerminalStatus; view: never };
  'work-verification': {
    state: WorkVerificationLifecycleStatus; terminal: WorkVerificationTerminalStatus; view: never;
  };
  'brain-operation': { state: BrainOperationLifecycleState; terminal: BrainOperationTerminalState; view: never };
}

export type LifecycleName = keyof LifecycleStates;
export type LifecycleState<N extends LifecycleName> = LifecycleStates[N]['state'];
export type LifecycleTerminalState<N extends LifecycleName> = LifecycleStates[N]['terminal'];
export type LifecycleViewState<N extends LifecycleName> = LifecycleStates[N]['view'];

export interface Lifecycle<N extends LifecycleName = LifecycleName> {
  readonly name: N;
  readonly summary: string;
  readonly record: string;
  readonly authority: string;
  readonly states: readonly LifecycleState<N>[];
  readonly initial: LifecycleState<N>;
  readonly terminal: readonly LifecycleTerminalState<N>[];
  readonly active: readonly Exclude<LifecycleState<N>, LifecycleTerminalState<N>>[];
  readonly reserved: readonly LifecycleState<N>[];
  readonly views: readonly LifecycleViewState<N>[];
  readonly transitions: readonly (readonly [LifecycleState<N>, LifecycleState<N>])[];
  readonly labels: Readonly<Record<string, string>>;
  readonly notes: readonly string[];
}

export interface LifecycleSpec {
  name: string;
  summary?: string;
  record?: string;
  authority?: string;
  states: readonly string[];
  initial: string;
  terminal: readonly string[];
  reserved?: readonly string[];
  views?: readonly string[];
  transitions: readonly (readonly [string, string])[];
  labels?: Readonly<Record<string, string>>;
  notes?: readonly string[];
}

export interface LifecycleDescription {
  schema: 'home23.lifecycles.v1';
  lifecycles: Array<{
    name: string;
    summary: string;
    record: string;
    authority: string;
    initial: string;
    states: Array<{ state: string; label: string; terminal: boolean; reserved: boolean; next: string[] }>;
    views: Array<{ state: string; label: string }>;
    notes: string[];
  }>;
}

export interface LifecycleError extends Error {
  code: string;
  lifecycle: string;
  from?: unknown;
  to?: unknown;
}

export const LIFECYCLES: { readonly [N in LifecycleName]: Lifecycle<N> };
export const LIFECYCLE_NAMES: readonly LifecycleName[];
export const TERMINAL_ERROR_CODE: 'lifecycle_terminal';
export const TRANSITION_ERROR_CODE: 'lifecycle_transition_invalid';
export const UNKNOWN_LIFECYCLE_ERROR_CODE: 'lifecycle_unknown';
export const UNKNOWN_STATE_ERROR_CODE: 'lifecycle_state_unknown';

export function defineLifecycle(spec: LifecycleSpec): Lifecycle;
export function getLifecycle<N extends LifecycleName>(name: N): Lifecycle<N>;
export function isState<N extends LifecycleName>(name: N, state: unknown): state is LifecycleState<N>;
export function isReportedState<N extends LifecycleName>(
  name: N, state: unknown,
): state is LifecycleState<N> | LifecycleViewState<N>;
export function isTerminal<N extends LifecycleName>(name: N, state: unknown): state is LifecycleTerminalState<N>;
export function isActive<N extends LifecycleName>(
  name: N, state: unknown,
): state is Exclude<LifecycleState<N>, LifecycleTerminalState<N>>;
export function terminalStates<N extends LifecycleName>(name: N): readonly LifecycleTerminalState<N>[];
export function canTransition(name: LifecycleName, from: unknown, to: unknown): boolean;
export function assertTransition(name: LifecycleName, from: unknown, to: unknown): void;
export function assertTerminal<N extends LifecycleName>(
  name: N, state: unknown,
): asserts state is LifecycleTerminalState<N>;
export function labelFor(name: LifecycleName, state: unknown): string | null;
export function describeLifecycles(): LifecycleDescription;
export function renderLifecycleReference(): string;
