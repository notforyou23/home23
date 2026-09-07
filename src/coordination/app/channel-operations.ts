import type { CoordinationTurnOrigin } from '../../agent/types.js';
import type { createChannelService } from '../channels/service.js';
import type { MessagingActorContext, ResponderPolicy } from '../channels/types.js';
import { WorkError } from '../work/errors.js';
import type { DetachmentCredential } from './foreground-detachments.js';

/** Current fenced house agents share the owner's channel mandate under their own identities. */
export function createChannelOperationConsumer(options: {
  authorize(credential: DetachmentCredential, origin: CoordinationTurnOrigin): unknown;
  authorizeRead?(credential: DetachmentCredential, origin: CoordinationTurnOrigin): unknown;
  assertCurrentDirection?(workId: string): void;
  context(origin: CoordinationTurnOrigin): MessagingActorContext;
  channels: ReturnType<typeof createChannelService>;
  listBots(): Promise<unknown>;
  workDiagnostics?(principalId: string, args: Record<string, unknown>, origin: CoordinationTurnOrigin): unknown;
  cancelWork?(context: MessagingActorContext, workId: string, key: string): Promise<unknown>;
  reportOutcome?(context: MessagingActorContext, origin: CoordinationTurnOrigin, args: Record<string, unknown>, key: string): unknown;
  invoke?(credential: DetachmentCredential, input: { origin: CoordinationTurnOrigin; invocationId: string; args: Record<string, unknown> }): Promise<unknown>;
  history?(context: MessagingActorContext, args: Record<string, unknown>, origin: CoordinationTurnOrigin): Promise<unknown>;
  project?(context: MessagingActorContext, origin: CoordinationTurnOrigin, args: Record<string, unknown>): Promise<unknown>;
  botOperation(context: MessagingActorContext, args: Record<string, unknown>, key: string): Promise<unknown>;
}) {
  return async (credential: DetachmentCredential, raw: unknown) => {
    const input = raw as { origin: CoordinationTurnOrigin; invocationId: string; args: Record<string, unknown> };
    const diagnostics = ['work_list', 'work_status'].includes(String(input?.args?.operation));
    if (!input?.origin ||
        typeof input.invocationId !== 'string' || !input.invocationId || input.invocationId.length > 256 ||
        !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
      throw new WorkError('ineligible', 'channel operation requires the authenticated executive resident');
    }
    if (['bot_invoke', 'bot_result', 'bot_stop'].includes(String(input.args.operation))) {
      if (!options.invoke) throw new Error('Bot invocation runtime unavailable');
      if (input.args.operation === 'bot_invoke') {
        options.authorize(credential, input.origin);
        options.assertCurrentDirection?.(input.origin.workId);
      }
      return options.invoke(credential, input);
    }
    if (diagnostics) (options.authorizeRead ?? options.authorize)(credential, input.origin);
    else options.authorize(credential, input.origin);
    if (diagnostics) {
      if (!options.workDiagnostics) throw new Error('Canonical work diagnostics unavailable');
      return options.workDiagnostics(input.origin.holderPrincipalId, input.args, input.origin);
    }
    const context = options.context(input.origin);
    const args = input.args;
    if (!['work_cancel', 'work_report_outcome', 'get', 'list', 'bot_list', 'project_context', 'project_read', 'history'].includes(String(args.operation))) options.assertCurrentDirection?.(input.origin.workId);
    const key = `${input.origin.workId}:${input.origin.attemptId}:${input.invocationId}`;
    const text = (name: string) => {
      if (typeof args[name] !== 'string') throw new WorkError('invalid_request', `${name} is required`);
      return args[name] as string;
    };
    const members = () => {
      if (!Array.isArray(args.memberBotIds) || args.memberBotIds.some(id => typeof id !== 'string'))
        throw new WorkError('invalid_request', 'memberBotIds is required');
      return args.memberBotIds as string[];
    };
    switch (args.operation) {
      case 'history':
        if (!options.history) throw new Error('Channel history unavailable');
        return options.history(context,args,input.origin);
      case 'project_context': case 'project_read': case 'project_write':
        if (!options.project) throw new Error('Project continuity unavailable');
        return options.project(context, input.origin, args);
      case 'work_report_outcome':
        if (!options.reportOutcome) throw new Error('Assignment conclusions unavailable');
        return options.reportOutcome(context, input.origin, args, key);
      case 'work_cancel':
        if (!options.cancelWork) throw new Error('Canonical work cancellation unavailable');
        return options.cancelWork(context, text('work_id'), key);
      case 'bot_create': case 'bot_archive': case 'bot_restore':
        return options.botOperation(context, args, key);
      case 'bot_list': return { bots: await options.listBots() };
      case 'list': return options.channels.listChannels({ context, cursor: typeof args.cursor === 'string' ? args.cursor : null, limit: typeof args.limit === 'number' ? args.limit : 50 });
      case 'get': return options.channels.getChannel({ context, channelId: text('channelId') });
      case 'create': return options.channels.createGroupChannel({
        context, idempotencyKey: key, title: text('title'), purpose: text('purpose'),
        memberBotIds: [...new Set([...members(), context.principalId])],
        pinned: args.pinned === true, responderPolicy: (args.responderPolicy ?? { mode: 'mention_or_coordinator', coordinatorBotId: context.principalId, responseOrder: 'sequential', maxBotTurns: 4 }) as ResponderPolicy,
      });
      case 'update': return options.channels.updateChannel({
        context, idempotencyKey: key, channelId: text('channelId'), expectedVersion: args.expectedVersion as number,
        title: text('title'), purpose: text('purpose'), memberBotIds: members(),
        responderPolicy: args.responderPolicy as ResponderPolicy, pinned: args.pinned as boolean,
        lifecycle: args.lifecycle as 'active' | 'archived',
      });
      default: throw new WorkError('invalid_request', 'unknown channel operation');
    }
  };
}
