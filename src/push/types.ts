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
}

/** In-memory + on-disk registry shape. */
export interface DeviceRegistryFile {
  version: 1;
  devices: DeviceRegistration[];
}

/** APNs auth + routing config, loaded from home23 secrets. */
export interface ApnsConfig {
  team_id: string;           // 10-char Apple Team ID
  key_id: string;            // 10-char .p8 key ID
  key_path: string;          // absolute path to AuthKey_XXXXXXXXXX.p8
  bundle_id: string;         // e.g. com.regina6.home23
  default_env: 'sandbox' | 'production';
}

/** What gets sent to api.push.apple.com. */
export interface PushPayload {
  aps: {
    alert: { title: string; body: string };
    'mutable-content': 1;
    sound: 'default';
  };
  chatId: string;
  turnId: string;
  agent: string;
}
