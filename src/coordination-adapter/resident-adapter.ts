import { createHash } from 'node:crypto';
import type { AgentEvent, CoordinationTurnOrigin } from '../agent/types.js';
import type {
  ResidentAgentPort,
  ResidentCoordinationPort,
  ResidentLeaseBinding,
  ResidentObservation,
  ResidentRun,
  ResidentTerminalReceipt,
  ResidentWorkRequest,
} from './types.js';

const MAX_OBSERVATIONS = 32;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function bindingFor(request: ResidentWorkRequest): ResidentLeaseBinding {
  const { origin } = request;
  return Object.freeze({
    workId: origin.workId,
    attemptId: origin.attemptId,
    leaseId: origin.leaseId,
    holderPrincipalId: origin.holderPrincipalId,
    holderInstanceId: origin.holderInstanceId,
    authorityReference: origin.authorityReference,
    fencingToken: origin.fencingToken,
    requestId: request.requestId,
    correlationId: request.correlationId,
  });
}

function privacySafeOrigin(origin: CoordinationTurnOrigin): CoordinationTurnOrigin {
  return Object.freeze({
    kind: 'coordination',
    workId: origin.workId,
    attemptId: origin.attemptId,
    leaseId: origin.leaseId,
    holderPrincipalId: origin.holderPrincipalId,
    holderInstanceId: origin.holderInstanceId,
    authorityReference: origin.authorityReference,
    fencingToken: origin.fencingToken,
    channelId: origin.channelId,
    originMessageId: origin.originMessageId,
    roundId: origin.roundId,
  });
}

function boundedObservation(event: AgentEvent, at: string): ResidentObservation {
  const outcomeCode = event.type === 'status' && typeof event.status === 'string'
    ? event.status.slice(0, 64)
    : event.type;
  return Object.freeze({
    kind: event.type,
    outcomeCode,
    evidenceDigest: digest(JSON.stringify({ kind: event.type, outcomeCode })),
    at,
  });
}

export class ResidentCoordinationAdapter {
  private readonly active = new Map<string, {
    chatId: string;
    turnId: string;
    binding: ResidentLeaseBinding;
    cancelling: boolean;
  }>();

  constructor(
    private readonly agent: ResidentAgentPort,
    private readonly coordination: ResidentCoordinationPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(request: ResidentWorkRequest): Promise<ResidentRun> {
    if (!request.instruction.trim()) throw new TypeError('resident Work instruction is required');
    if (request.origin.kind !== 'coordination') throw new TypeError('coordination origin is required');
    if (this.active.has(request.origin.workId)) {
      throw new Error('resident Work already has an active turn');
    }
    const origin = privacySafeOrigin(request.origin);
    const binding = bindingFor(request);
    let observations = 0;
    let callbackChain = Promise.resolve();
    const fenceCallback = (callback: () => void | Promise<void>): void => {
      callbackChain = callbackChain.then(async () => {
        await this.coordination.assertCurrent(binding);
        await callback();
      });
      callbackChain.catch(() => {
        const active = this.active.get(origin.workId);
        if (active) this.agent.stop(active.chatId, active.turnId);
      });
    };

    const started = await this.agent.runWithTurn(request.chatId, request.instruction, {
      coordinationOrigin: origin,
      onDurableStart: async ({ turnId }) => {
        await this.coordination.assertCurrent(binding);
        await this.coordination.accept(binding);
        await this.coordination.assertCurrent(binding);
        await this.coordination.start(binding);
        this.active.set(origin.workId, { chatId: request.chatId, turnId, binding, cancelling: false });
      },
      onEvent: (event) => {
        if (!this.coordination.observe || observations >= MAX_OBSERVATIONS) return;
        observations += 1;
        fenceCallback(() => this.coordination.observe!(binding, boundedObservation(event, this.now().toISOString())));
      },
    });

    const receipt = (async (): Promise<unknown> => {
      try {
        let terminal: ResidentTerminalReceipt;
        try {
          const response = await started.response;
          await callbackChain;
          const cancelled = this.active.get(origin.workId)?.cancelling === true;
          terminal = Object.freeze({
            status: cancelled ? 'cancelled' : 'succeeded',
            sourceReference: origin.authorityReference,
            resultDigest: cancelled ? null : digest(response.text),
            artifactIds: Object.freeze([]),
            timestamp: this.now().toISOString(),
          });
        } catch (error) {
          await callbackChain;
          const cancelled = this.active.get(origin.workId)?.cancelling === true;
          terminal = Object.freeze({
            status: cancelled ? 'cancelled' : 'failed',
            sourceReference: origin.authorityReference,
            resultDigest: cancelled ? null : digest(error instanceof Error ? error.message : String(error)),
            artifactIds: Object.freeze([]),
            timestamp: this.now().toISOString(),
          });
        }
        await this.coordination.assertCurrent(binding);
        return await this.coordination.terminalize({ ...binding, receipt: terminal });
      } finally {
        this.active.delete(origin.workId);
      }
    })();

    return Object.freeze({ turnId: started.turnId, response: started.response, receipt });
  }

  async cancel(workId: string, reasonCode = 'coordination_cancel'): Promise<boolean> {
    const active = this.active.get(workId);
    if (!active) return false;
    if (active.cancelling) return false;
    await this.coordination.assertCurrent(active.binding);
    await this.coordination.revoke({ ...active.binding, reasonCode });
    active.cancelling = true;
    return this.agent.stop(active.chatId, active.turnId).stopped;
  }
}
