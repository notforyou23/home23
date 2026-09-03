import type { MessagingActorContext } from '../coordination/channels/index.js';
import type { CoordinationDeviceNotificationPort } from '../coordination/app/types.js';
import type { ApnsPusher } from './apns-pusher.js';
import type { DeviceRegistry } from './device-registry.js';

const APNS_TOKEN_PATTERN = /^[0-9a-f]{32,256}$/i;

/** Canonical device registration. Identity always comes from product auth. */
export class ConnectedAgentsNotificationService
implements CoordinationDeviceNotificationPort {
  constructor(
    private readonly registry: DeviceRegistry,
    private readonly pusher: Pick<ApnsPusher, 'notifyConnectedAgentsMessage'>,
    private readonly bundleId: string,
  ) {}

  registerCurrent(input: {
    context: MessagingActorContext;
    deviceToken: string;
    environment: 'sandbox' | 'production';
    platform: 'ios' | 'macos';
    appBuild: string | null;
  }) {
    if (input.context.identity.kind !== 'owner') {
      throw new TypeError('connected_agents_device_auth_required');
    }
    if (!APNS_TOKEN_PATTERN.test(input.deviceToken) ||
        (input.appBuild !== null &&
          (input.appBuild.length < 1 || input.appBuild.length > 128))) {
      throw new TypeError('connected_agents_device_registration_invalid');
    }
    const auth = input.context.identity.auth;
    const registration = this.registry.register({
      device_token: input.deviceToken.toLowerCase(),
      bundle_id: this.bundleId,
      env: input.environment,
      chat_ids: [],
      platform: input.platform,
      ...(input.appBuild === null ? {} : { app_build: input.appBuild }),
      connected_agents_notifications: true,
      coordination_device_id: auth.deviceId,
      coordination_session_id: auth.sessionId,
    });
    return Object.freeze({
      registered: true as const,
      deviceId: auth.deviceId,
      sessionId: auth.sessionId,
      environment: registration.env,
      updatedAt: registration.last_seen_at,
    });
  }

  notifyMessageCommitted(
    input: Parameters<ApnsPusher['notifyConnectedAgentsMessage']>[0],
  ): Promise<void> {
    return this.pusher.notifyConnectedAgentsMessage(input);
  }
}
