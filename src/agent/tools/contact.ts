/**
 * Contact tools — Mac, house, intake, browser completion, phone, comms.
 * Every write/physical/send path goes through dry-run or confirm and a receipt.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { scanAttention } from '../contact/attention.js';
import { runBrowserWorkflow } from '../contact/browser.js';
import { captureArtifact, listInbox, retrieveArtifact } from '../contact/capture.js';
import { assertSendable, createDraft, loadDraft, previewDraft } from '../contact/comms.js';
import { HouseClient } from '../contact/house.js';
import { createOsascriptRunner, macRead, macWrite, type MacReadSurface } from '../contact/mac.js';
import { runNamedShortcut } from '../contact/phone.js';
import { buildReceipt, writeContactReceipt } from '../contact/receipts.js';
import { loadHomeAssistantCreds, loadShortcutBridge } from '../contact/secrets.js';
import type { ContactReceipt } from '../contact/types.js';

function receiptResult(workspacePath: string, receipt: ContactReceipt, extra?: unknown): ToolResult {
  writeContactReceipt(workspacePath, receipt);
  const payload = extra === undefined ? receipt : { receipt, result: extra };
  return {
    content: JSON.stringify(payload, null, 2),
    ...(receipt.ok ? {} : { is_error: true }),
    metadata: { contactReceiptId: receipt.id, capability: receipt.capability },
  };
}

function fail(ctx: ToolContext, capability: string, error: unknown, extras: Partial<ContactReceipt> = {}): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return receiptResult(ctx.workspacePath, buildReceipt({
    agent: ctx.agentName,
    chatId: ctx.chatId,
    capability,
    sideEffect: extras.sideEffect ?? 'read',
    authority: extras.authority ?? 'autonomous',
    dryRun: extras.dryRun ?? false,
    confirmed: extras.confirmed ?? false,
    ok: false,
    summary: message,
    error: message,
    ...extras,
  }));
}

function houseClient(ctx: ToolContext): HouseClient {
  const creds = loadHomeAssistantCreds(ctx.projectRoot);
  if (!creds) throw new Error('homeAssistant.url/token missing from config/secrets.yaml');
  return new HouseClient({ creds, fetchImpl: ctx.fetch ?? fetch });
}

export const houseGetEntityTool: ToolDefinition = {
  name: 'house_get_entity',
  description: 'Read one Home Assistant entity state. Observe-only.',
  input_schema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: 'Home Assistant entity id, e.g. light.kitchen' },
    },
    required: ['entity_id'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const entity = await houseClient(ctx).getEntity(String(input.entity_id));
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'house_get_entity',
        sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
        summary: `${entity.entity_id} is ${entity.state}`, after: entity,
      }), entity);
    } catch (error) {
      return fail(ctx, 'house_get_entity', error);
    }
  },
};

export const houseGetAreaTool: ToolDefinition = {
  name: 'house_get_area',
  description: 'Read Home Assistant entities in an area (kitchen, garage, etc.). Observe-only.',
  input_schema: {
    type: 'object',
    properties: {
      area: { type: 'string', description: 'Home Assistant area name or id' },
    },
    required: ['area'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const area = await houseClient(ctx).getArea(String(input.area));
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'house_get_area',
        sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
        summary: `${area.area}: ${area.entities.length} entities`, after: area,
      }), area);
    } catch (error) {
      return fail(ctx, 'house_get_area', error);
    }
  },
};

export const houseHistoryTool: ToolDefinition = {
  name: 'house_history',
  description: 'Read recent Home Assistant history for one entity. Observe-only.',
  input_schema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string' },
      hours: { type: 'number', description: 'Hours of history (default 24)' },
    },
    required: ['entity_id'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const history = await houseClient(ctx).history(String(input.entity_id), Number(input.hours ?? 24));
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'house_history',
        sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
        summary: `history for ${String(input.entity_id)}`, after: history,
      }), history);
    } catch (error) {
      return fail(ctx, 'house_history', error);
    }
  },
};

async function executeHouseAct(
  ctx: ToolContext,
  capability: string,
  input: Record<string, unknown>,
  defaults: { domain?: string; service?: string },
): Promise<ToolResult> {
  try {
    const entityId = String(input.entity_id ?? '');
    const domain = String(input.domain ?? defaults.domain ?? entityId.split('.')[0] ?? '');
    const service = String(input.service ?? defaults.service ?? '');
    if (!entityId || !domain || !service) throw new Error('entity_id, domain, and service are required');
    const result = await houseClient(ctx).actClosedLoop({
      entityId,
      domain,
      service,
      data: (input.data as Record<string, unknown> | undefined) ?? undefined,
      dryRun: Boolean(input.dry_run),
      confirm: Boolean(input.confirm),
    });
    const ok = !result.refused;
    return receiptResult(ctx.workspacePath, buildReceipt({
      agent: ctx.agentName, chatId: ctx.chatId, capability,
      sideEffect: 'physical',
      authority: result.lane === 'autonomous' ? 'autonomous' : 'confirm',
      dryRun: result.dryRun, confirmed: Boolean(input.confirm), ok,
      summary: result.refused
        ? result.refused
        : result.dryRun
          ? `dry-run ${domain}.${service} on ${entityId} (now ${result.before.state})`
          : `${domain}.${service} on ${entityId}: ${result.before.state} → ${result.after?.state ?? 'unknown'} verified=${result.verified}`,
      before: result.before, after: result.after, verified: result.verified,
      error: result.refused, metadata: { lane: result.lane, called: result.called },
    }), result);
  } catch (error) {
    return fail(ctx, capability, error, { sideEffect: 'physical', authority: 'confirm' });
  }
}

export const houseCallSafeServiceTool: ToolDefinition = {
  name: 'house_call_safe_service',
  description: 'Call a Home Assistant service with closed-loop verification (observe → command → observe). Lights/music/fans/scenes may run autonomously. Thermostat, cameras, garage, locks, security, and water require confirm=true. Use dry_run=true to preview.',
  input_schema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string' },
      domain: { type: 'string', description: 'Service domain (default: entity domain)' },
      service: { type: 'string', description: 'Service name, e.g. turn_on' },
      data: { type: 'object', additionalProperties: true, description: 'Optional service data' },
      dry_run: { type: 'boolean' },
      confirm: { type: 'boolean', description: 'Required for policy-lane entities' },
    },
    required: ['entity_id', 'service'],
  },
  async execute(input, ctx) {
    return executeHouseAct(ctx, 'house_call_safe_service', input, {});
  },
};

export const houseSceneActivateTool: ToolDefinition = {
  name: 'house_scene_activate',
  description: 'Activate a Home Assistant scene with closed-loop verification. Benign scenes are autonomous. Use dry_run=true to preview.',
  input_schema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: 'scene.* entity id' },
      dry_run: { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
    required: ['entity_id'],
  },
  async execute(input, ctx) {
    return executeHouseAct(ctx, 'house_scene_activate', { ...input, domain: 'scene', service: 'turn_on' }, {
      domain: 'scene', service: 'turn_on',
    });
  },
};

export const houseVerifyChangeTool: ToolDefinition = {
  name: 'house_verify_change',
  description: 'Re-read a Home Assistant entity and compare against an expected state. Use after a house action.',
  input_schema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string' },
      expected_state: { type: 'string' },
    },
    required: ['entity_id'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const entity = await houseClient(ctx).getEntity(String(input.entity_id));
      const expected = input.expected_state !== undefined ? String(input.expected_state) : undefined;
      const verified = expected === undefined ? true : entity.state === expected;
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'house_verify_change',
        sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: verified,
        summary: expected
          ? `${entity.entity_id} is ${entity.state}, expected ${expected}, verified=${verified}`
          : `${entity.entity_id} is ${entity.state}`,
        after: entity, verified,
        error: verified ? undefined : `state mismatch: ${entity.state} !== ${expected}`,
      }), entity);
    } catch (error) {
      return fail(ctx, 'house_verify_change', error);
    }
  },
};

export const macReadTool: ToolDefinition = {
  name: 'mac_read',
  description: 'Read-only Mac contact: calendar, reminders, notes, Mail, or Finder/Spotlight. Does not send or change anything.',
  input_schema: {
    type: 'object',
    properties: {
      surface: { type: 'string', description: 'calendar | reminders | notes | mail | finder' },
      query: { type: 'string', description: 'Search text for notes/mail/finder' },
      hours_ahead: { type: 'number', description: 'Calendar window in hours (default 36)' },
    },
    required: ['surface'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const surface = String(input.surface) as MacReadSurface;
    try {
      const items = await macRead(surface, String(input.query ?? ''), createOsascriptRunner(), Number(input.hours_ahead ?? 36));
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'mac_read',
        sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
        summary: `${surface}: ${items.length} items`, after: items,
      }), items);
    } catch (error) {
      return fail(ctx, 'mac_read', error, { metadata: { surface } });
    }
  },
};

export const macWriteTool: ToolDefinition = {
  name: 'mac_write',
  description: 'Narrow Mac writes: create a reminder or run a named Shortcuts.app shortcut. dry_run=true previews. create_reminder is allowed; run_shortcut requires confirm=true.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'create_reminder | run_shortcut' },
      title: { type: 'string' },
      notes: { type: 'string' },
      shortcut: { type: 'string' },
      dry_run: { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
    required: ['action'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const action = String(input.action);
    try {
      if (action === 'run_shortcut' && !input.dry_run && !input.confirm) {
        throw new Error('run_shortcut requires confirm=true');
      }
      const result = await macWrite(
        action as 'create_reminder' | 'run_shortcut',
        {
          title: input.title as string | undefined,
          notes: input.notes as string | undefined,
          shortcut: input.shortcut as string | undefined,
          dryRun: Boolean(input.dry_run),
        },
        createOsascriptRunner(),
      );
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'mac_write',
        sideEffect: 'write', authority: action === 'run_shortcut' ? 'confirm' : 'autonomous',
        dryRun: result.dryRun, confirmed: Boolean(input.confirm), ok: true,
        summary: result.dryRun ? `dry-run ${action}` : `did ${action}`,
        after: result.result, metadata: { action },
      }), result);
    } catch (error) {
      return fail(ctx, 'mac_write', error, { sideEffect: 'write', authority: 'confirm', metadata: { action } });
    }
  },
};

export const attentionScanTool: ToolDefinition = {
  name: 'attention_scan',
  description: 'What actually needs the owner: calendar, reminders, notes, optionally Mail/Finder, ranked into events/commitments/messages. Degraded-honest if a Mac surface is unavailable.',
  input_schema: {
    type: 'object',
    properties: {
      hours_ahead: { type: 'number' },
      query: { type: 'string' },
      include_mail: { type: 'boolean' },
      include_finder: { type: 'boolean' },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const scan = await scanAttention({
        hoursAhead: input.hours_ahead as number | undefined,
        query: input.query as string | undefined,
        includeMail: Boolean(input.include_mail),
        includeFinder: Boolean(input.include_finder),
      }, createOsascriptRunner());
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'attention_scan',
        sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
        summary: `${scan.items.length} items; degraded=${scan.degraded.length}`, after: scan,
      }), scan);
    } catch (error) {
      return fail(ctx, 'attention_scan', error);
    }
  },
};

export const captureArtifactTool: ToolDefinition = {
  name: 'capture_artifact',
  description: 'Take a file (PDF, photo, note, receipt, voice memo) and make it part of the world: exact archive, excerpt, provenance, action candidates. action=ingest (default), retrieve, or inbox.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'ingest | retrieve | inbox' },
      path: { type: 'string', description: 'Source file for ingest' },
      artifact_id: { type: 'string', description: 'Id for retrieve' },
      project: { type: 'string' },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const action = String(input.action ?? 'ingest');
    try {
      if (action === 'inbox') {
        const files = listInbox(ctx.workspacePath);
        return receiptResult(ctx.workspacePath, buildReceipt({
          agent: ctx.agentName, chatId: ctx.chatId, capability: 'capture_artifact',
          sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
          summary: `inbox: ${files.length} file(s)`, after: files,
        }), files);
      }
      if (action === 'retrieve') {
        const record = retrieveArtifact(ctx.workspacePath, String(input.artifact_id ?? ''));
        return receiptResult(ctx.workspacePath, buildReceipt({
          agent: ctx.agentName, chatId: ctx.chatId, capability: 'capture_artifact',
          sideEffect: 'read', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
          summary: `retrieved ${record.id}`, after: record,
        }), record);
      }
      const record = captureArtifact({
        sourcePath: String(input.path ?? ''),
        workspacePath: ctx.workspacePath,
        projectRoot: ctx.projectRoot,
        project: input.project as string | undefined,
      });
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'capture_artifact',
        sideEffect: 'write', authority: 'autonomous', dryRun: false, confirmed: false, ok: true,
        summary: `archived ${record.originalName} as ${record.id}`, after: record,
      }), record);
    } catch (error) {
      return fail(ctx, 'capture_artifact', error, { sideEffect: 'write' });
    }
  },
};

export const browserWorkflowTool: ToolDefinition = {
  name: 'browser_workflow',
  description: 'Complete a web page workflow with before/after snapshots. Default action is open (navigate + extract). action=submit requires confirm=true. Prefer this over web_browse when the result of the page matters.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      action: { type: 'string', description: 'open (default) | submit' },
      wait_ms: { type: 'number' },
      confirm: { type: 'boolean' },
    },
    required: ['url'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      if (!ctx.browser) throw new Error('Browser not available. Chrome must be running with remote debugging.');
      const result = await runBrowserWorkflow({
        browser: ctx.browser,
        url: String(input.url),
        waitMs: input.wait_ms as number | undefined,
        action: input.action === 'submit' ? 'submit' : 'open',
        confirmSubmit: Boolean(input.confirm),
      });
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'browser_workflow',
        sideEffect: input.action === 'submit' ? 'write' : 'read',
        authority: input.action === 'submit' ? 'confirm' : 'autonomous',
        dryRun: false, confirmed: Boolean(input.confirm), ok: true,
        summary: `${result.after.title} — ${result.after.url}`, after: result.after,
      }), result.after);
    } catch (error) {
      return fail(ctx, 'browser_workflow', error, {
        sideEffect: input.action === 'submit' ? 'write' : 'read',
        authority: input.action === 'submit' ? 'confirm' : 'autonomous',
      });
    }
  },
};

export const phoneRunShortcutTool: ToolDefinition = {
  name: 'phone_run_shortcut',
  description: 'Run a named iOS Shortcut via the configured shortcut bridge. Allowlisted names only. Requires confirm=true. dry_run=true previews.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      dry_run: { type: 'boolean' },
      confirm: { type: 'boolean' },
    },
    required: ['name'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const result = await runNamedShortcut(
        String(input.name),
        loadShortcutBridge(ctx.projectRoot),
        ctx.fetch ?? fetch,
        { confirm: Boolean(input.confirm), dryRun: Boolean(input.dry_run) },
      );
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'phone_run_shortcut',
        sideEffect: 'write', authority: 'confirm', dryRun: result.dryRun, confirmed: Boolean(input.confirm),
        ok: result.ok, summary: result.detail, after: result,
      }), result);
    } catch (error) {
      return fail(ctx, 'phone_run_shortcut', error, { sideEffect: 'write', authority: 'confirm' });
    }
  },
};

export const commsDraftTool: ToolDefinition = {
  name: 'comms_draft',
  description: 'Draft a message in the owner voice for telegram/email/imessage/discord/x. Does not send. Returns a preview with recipient, flags, and draft_id.',
  input_schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'telegram | email | imessage | discord | x' },
      to: { type: 'string', description: 'Recipient chat id or address' },
      body: { type: 'string' },
      subject: { type: 'string' },
    },
    required: ['channel', 'to', 'body'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const draft = createDraft({
        workspacePath: ctx.workspacePath,
        projectRoot: ctx.projectRoot,
        channel: String(input.channel) as 'telegram' | 'email' | 'imessage' | 'discord' | 'x',
        to: String(input.to),
        body: String(input.body),
        subject: input.subject as string | undefined,
      });
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'comms_draft',
        sideEffect: 'write', authority: 'autonomous', dryRun: true, confirmed: false, ok: true,
        summary: `draft ${draft.id} to ${draft.to} via ${draft.channel}`, after: draft,
      }), { draft, preview: previewDraft(draft) });
    } catch (error) {
      return fail(ctx, 'comms_draft', error, { sideEffect: 'write' });
    }
  },
};

export const commsSendTool: ToolDefinition = {
  name: 'comms_send',
  description: 'Send a previously drafted message. Telegram only for now. Requires draft_id from comms_draft and confirm=true. Preview is returned if confirm is missing.',
  input_schema: {
    type: 'object',
    properties: {
      draft_id: { type: 'string' },
      confirm: { type: 'boolean' },
    },
    required: ['draft_id'],
  },
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const draft = loadDraft(ctx.workspacePath, String(input.draft_id));
      if (!input.confirm) {
        return receiptResult(ctx.workspacePath, buildReceipt({
          agent: ctx.agentName, chatId: ctx.chatId, capability: 'comms_send',
          sideEffect: 'external-send', authority: 'confirm', dryRun: true, confirmed: false, ok: true,
          summary: `preview only — pass confirm=true to send ${draft.id}`, after: draft,
        }), { preview: previewDraft(draft), draft });
      }
      assertSendable(draft, true);
      const sendText = ctx.telegramAdapter?.sendText;
      if (!sendText) throw new Error('telegram adapter has no sendText — cannot deliver');
      await sendText(draft.to, draft.body);
      return receiptResult(ctx.workspacePath, buildReceipt({
        agent: ctx.agentName, chatId: ctx.chatId, capability: 'comms_send',
        sideEffect: 'external-send', authority: 'confirm', dryRun: false, confirmed: true, ok: true,
        summary: `sent ${draft.id} to ${draft.to} via telegram`, after: { draftId: draft.id, to: draft.to },
        verified: true,
      }));
    } catch (error) {
      return fail(ctx, 'comms_send', error, { sideEffect: 'external-send', authority: 'confirm' });
    }
  },
};

export const contactTools: ToolDefinition[] = [
  houseGetEntityTool,
  houseGetAreaTool,
  houseHistoryTool,
  houseCallSafeServiceTool,
  houseSceneActivateTool,
  houseVerifyChangeTool,
  macReadTool,
  macWriteTool,
  attentionScanTool,
  captureArtifactTool,
  browserWorkflowTool,
  phoneRunShortcutTool,
  commsDraftTool,
  commsSendTool,
];
