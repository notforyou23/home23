/** Per-device APNs registration. One row per (agent, device_token) pair. */
export interface DeviceRegistration {
  device_token: string;      // APNs hex token from UIApplication.registerForRemoteNotifications
  chat_ids: string[];        // conversations this device is subscribed to
  registered_at: string;     // ISO8601
  last_seen_at: string;      // ISO8601, updated on any register call
  bundle_id: string;         // com.regina6.home23 — allows multiple apps later
  env: 'sandbox' | 'production';  // APNs environment
  agent_id?: string;         // owning Home23 agent bridge
  platform?: string;         // ios, mac, tvos
  app_build?: string | number;
  contract_version?: string;
  capabilities_hash?: string;
  installation_id?: string;   // stable Keychain installation identity
  query_notifications?: boolean; // capability only; never operation authority
  connected_agents_notifications?: boolean;
  coordination_device_id?: string;
  coordination_session_id?: string;
}

/** Native Mac Connected Agents topic. Distinct from the iPhone canary/release topic. */
export const CONNECTED_AGENTS_MAC_BUNDLE_ID = 'com.regina6.home23.mac';

function connectedAgentsDeviceIsMac(device: DeviceRegistration): boolean {
  return device.platform === 'macos' || device.platform === 'mac';
}

function connectedAgentsDeviceIsIOS(device: DeviceRegistration): boolean {
  return device.platform === 'ios' || device.platform === undefined;
}

/**
 * iPhone is the interrupt device when both are current. Mac still receives the
 * time-sensitive alert when it is the only current Connected Agents platform.
 */
export function selectConnectedAgentsAlertDevices(
  devices: readonly DeviceRegistration[],
): DeviceRegistration[] {
  const hasIOS = devices.some(connectedAgentsDeviceIsIOS);
  if (!hasIOS) return [...devices];
  return devices.filter((device) => !connectedAgentsDeviceIsMac(device));
}

/** Durable Query-notebook credential enrollment. Independent of APNs registration. */
export interface QueryCredentialRegistration {
  installation_id: string;
  requester_agent: string;
  credential_id: string;
  credential_generation: number;
  enrolled_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export type QueryTerminalState = 'complete' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

export interface QueryNotificationDeliveryReceipt {
  route_id: string;
  operation_id: string;
  device_id: string;
  generation: number;
  terminal_state: QueryTerminalState;
  state: 'pending' | 'failed' | 'delivered';
  attempts: number;
  updated_at: string;
  delivered_at: string | null;
  retryable: boolean;
  error_code: string | null;
}

/** In-memory + on-disk registry shape. */
export interface DeviceRegistryFile {
  version: 2;
  devices: DeviceRegistration[];
  query_credentials: QueryCredentialRegistration[];
  query_delivery_receipts: QueryNotificationDeliveryReceipt[];
}

/** APNs auth + routing config, loaded from home23 secrets. */
export interface ApnsConfig {
  team_id: string;           // 10-char Apple Team ID
  key_id: string;            // 10-char .p8 key ID
  key_path: string;          // absolute path to AuthKey_XXXXXXXXXX.p8
  bundle_id: string;         // e.g. com.regina6.home23.connectedagents.canary
  macos_bundle_id?: string;  // native Mac topic; defaults to CONNECTED_AGENTS_MAC_BUNDLE_ID
  default_env: 'sandbox' | 'production';
}

/** What gets sent to api.push.apple.com. */
export interface ChatPushPayload {
  aps: {
    alert: { title: string; body: string };
    'mutable-content': 1;
    sound: 'default';
  };
  chatId: string;
  turnId: string;
  agent: string;
  kind?: undefined;
}

export interface QueryPushPayload {
  aps: {
    alert: { title: string; body: string };
    'mutable-content': 1;
    sound: 'default';
  };
  kind: 'query_operation';
  operationId: string;
  state: QueryTerminalState;
  agent: string;
  routeId: string;
  generation: number;
}

/** Terminal async-work notification (Step 31). `kind` discriminates from legacy chat pushes. */
export interface AsyncWorkPushPayload {
  aps: {
    alert: { title: string; body: string };
    'mutable-content': 1;
    sound: 'default';
    'thread-id': string;
    category: 'CA_WORK';
    'interruption-level': 'time-sensitive';
  };
  kind: 'async_work';
  chatId: string;   // origin conversation to open on tap
  workId: string;   // work receipt to surface
  status: string;   // terminal AsyncWorkStatus
  agent: string;
}

const PUSH_ALERT_PREVIEW_LIMIT = 100;

/** Collapse whitespace and cap banner copy the same way legacy chat pushes do. */
export function previewPushAlertBody(text: string): string {
  const stripped = text.replace(/\s+/g, ' ').trim();
  if (stripped.length <= PUSH_ALERT_PREVIEW_LIMIT) return stripped;
  return `${stripped.slice(0, PUSH_ALERT_PREVIEW_LIMIT - 1)}…`;
}

/** Wake hint for one already-durable canonical Message. */
export interface ConnectedAgentsMessagePushPayload {
  aps: {
    alert: { title: string; subtitle?: string; body: string };
    'mutable-content': 1;
    sound: 'default';
    badge?: number;
    'thread-id': string;
    category: 'CA_MESSAGE';
    'interruption-level': 'time-sensitive';
  };
  kind: 'connected_agents_message';
  conversationId: string;
  channelId: string;
  messageId: string;
  workId?: string;
  agent?: string;
  displayName?: string;
}

export function buildConnectedAgentsMessagePayload(input: {
  conversationId: string;
  channelId: string;
  messageId: string;
  workId?: string;
  agent?: string;
  displayName?: string;
  conversationTitle?: string;
  preview?: string | null;
  hasAttachments?: boolean;
  badge?: number;
}): ConnectedAgentsMessagePushPayload {
  if (input.badge !== undefined && (!Number.isSafeInteger(input.badge) || input.badge < 0 || input.badge > 99_999)) throw new TypeError('invalid notification badge');
  const title = input.displayName ?? 'Home23';
  const subtitle = connectedAgentsAlertSubtitle(title, input.conversationTitle);
  const body = connectedAgentsAlertBody(input.preview, input.hasAttachments === true);
  return {
    aps: {
      alert: { title, ...(subtitle === undefined ? {} : { subtitle }), body },
      'mutable-content': 1,
      sound: 'default',
      ...(input.badge === undefined ? {} : { badge: input.badge }),
      'thread-id': `ca:${input.conversationId}:${input.channelId}`,
      category: 'CA_MESSAGE',
      'interruption-level': 'time-sensitive',
    },
    kind: 'connected_agents_message',
    conversationId: input.conversationId,
    channelId: input.channelId,
    messageId: input.messageId,
    ...(input.workId === undefined ? {} : { workId: input.workId }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  };
}

function connectedAgentsAlertSubtitle(title: string, conversationTitle?: string): string | undefined {
  if (conversationTitle === undefined) return undefined;
  const where = previewPushAlertBody(conversationTitle);
  if (!where || where === title) return undefined;
  return where;
}

function connectedAgentsAlertBody(preview: string | null | undefined, hasAttachments: boolean): string {
  const body = preview == null ? '' : previewPushAlertBody(preview);
  if (body) return body;
  if (hasAttachments) return 'Sent an attachment';
  return 'Reply ready';
}

export function buildAsyncWorkPayload(input: {
  agentName: string;
  chatId: string;
  workId: string;
  status: string;
  body: string;
}): AsyncWorkPushPayload {
  return {
    aps: {
      alert: { title: input.agentName, body: input.body },
      'mutable-content': 1,
      sound: 'default',
      'thread-id': `work:${input.workId}`,
      category: 'CA_WORK',
      'interruption-level': 'time-sensitive',
    },
    kind: 'async_work',
    chatId: input.chatId,
    workId: input.workId,
    status: input.status,
    agent: input.agentName,
  };
}

/** Wake when a durable Connected Agents Working Thread is already executing. */
export interface ConnectedAgentsWorkPushPayload {
  aps: {
    alert: { title: string; subtitle?: string; body: string };
    'mutable-content': 1;
    sound: 'default';
    'content-available': 1;
    'thread-id': string;
    category: 'CA_WORK';
    'interruption-level': 'time-sensitive';
  };
  kind: 'connected_agents_work';
  workId: string;
  conversationId: string;
  channelId: string;
  status: string;
  agent?: string;
  displayName?: string;
}

const CONNECTED_AGENTS_EXECUTING_WORK_STATES = new Set([
  'queued',
  'leased',
  'running',
  'cancelling',
]);

export function isConnectedAgentsExecutingWorkState(status: string): boolean {
  return CONNECTED_AGENTS_EXECUTING_WORK_STATES.has(status);
}

export function buildConnectedAgentsWorkPayload(input: {
  workId: string;
  conversationId: string;
  channelId: string;
  status: string;
  agent?: string;
  displayName?: string;
  conversationTitle?: string;
}): ConnectedAgentsWorkPushPayload {
  const title = input.displayName ?? input.agent ?? 'Home23';
  const subtitle = connectedAgentsAlertSubtitle(title, input.conversationTitle);
  return {
    aps: {
      alert: {
        title,
        ...(subtitle === undefined ? {} : { subtitle }),
        body: connectedAgentsWorkAlertBody(input.status),
      },
      'mutable-content': 1,
      sound: 'default',
      'content-available': 1,
      'thread-id': `work:${input.workId}`,
      category: 'CA_WORK',
      'interruption-level': 'time-sensitive',
    },
    kind: 'connected_agents_work',
    workId: input.workId,
    conversationId: input.conversationId,
    channelId: input.channelId,
    status: input.status,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  };
}

function connectedAgentsWorkAlertBody(status: string): string {
  switch (status) {
    case 'queued':
    case 'leased':
      return 'Queued';
    case 'cancelling':
      return 'Stopping';
    default:
      return 'Working';
  }
}

export type PushPayload = ChatPushPayload | QueryPushPayload | AsyncWorkPushPayload |
  ConnectedAgentsMessagePushPayload | ConnectedAgentsWorkPushPayload;
