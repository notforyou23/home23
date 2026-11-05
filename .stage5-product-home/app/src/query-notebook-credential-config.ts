interface QueryNotebookBridgeConfig {
  channels?: { webhooks?: { token?: string } };
  bridge?: { token?: string };
}

interface QueryNotebookBridgeEnvironment {
  BRIDGE_TOKEN?: string;
  HOME23_BRIDGE_TOKEN?: string;
}

/** Select the same enrollment secret source used by the dashboard authority. */
export function resolveQueryNotebookBridgeToken(
  config: QueryNotebookBridgeConfig,
  environment: QueryNotebookBridgeEnvironment = process.env,
): string {
  const candidates = [
    config.channels?.webhooks?.token,
    config.bridge?.token,
    environment.BRIDGE_TOKEN,
    environment.HOME23_BRIDGE_TOKEN,
  ];
  return candidates.find(candidate => typeof candidate === 'string' && candidate.length > 0) ?? '';
}
