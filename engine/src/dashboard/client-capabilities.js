const fs = require('fs');
const path = require('path');

const CONTRACT_VERSION = '2026.07.14';

function readPackageVersion(home23Root) {
  if (!home23Root) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(home23Root, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function buildClientCapabilities(options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const packageVersion = options.packageVersion || readPackageVersion(options.home23Root) || '1.0.0';

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt,
    server: {
      name: 'home23',
      version: packageVersion,
    },
    minIOSBuild: 1,
    platforms: {
      ios: {
        home: true,
        query: true,
        chat: true,
        sauna: true,
        settings: true,
        diagnostics: true,
        push: true,
      },
      mac: {
        home: true,
        query: true,
        chat: true,
        sauna: true,
        settings: true,
        diagnostics: true,
        push: true,
        workers: true,
      },
      tvos: {
        home: true,
        query: false,
        chat: true,
        sauna: true,
        settings: false,
        diagnostics: false,
        push: false,
      },
    },
    features: {
      multiAgent: true,
      selectedAgentChat: true,
      queryStreaming: true,
      saunaControl: true,
      pushRegistration: true,
      settingsControlPlane: true,
      chatTurnStatus: true,
      operatorDiagnostics: true,
    },
    endpoints: {
      agents: '/home23/api/settings/agents',
      settingsStatus: '/home23/api/settings/status',
      settingsScope: '/home23/api/settings/scope',
      settingsModels: '/home23/api/settings/models',
      settingsQuery: '/home23/api/settings/query',
      queryCatalog: '/home23/api/query/catalog',
      queryRun: '/home23/api/query/run',
      queryStream: '/home23/api/query/stream',
      queryNotebook: '/home23/api/query/notebook',
      queryOperation: '/home23/api/query/operations/{operationId}',
      queryOperationEvents: '/home23/api/query/operations/{operationId}/events',
      queryOperationResult: '/home23/api/query/operations/{operationId}/result',
      queryOperationExport: '/home23/api/query/operations/{operationId}/export',
      queryOperationCancel: '/home23/api/query/operations/{operationId}/cancel',
      queryOperationActions: '/home23/api/query/operations/{operationId}/actions',
      queryOperationNotifications: '/home23/api/query/operations/{operationId}/notifications',
      queryOperationHistory: '/home23/api/query/operations/{operationId}/history',
      queryDeviceCredential: '/api/device/query-credential',
      queryWebSession: '/home23/api/query/session',
      workers: '/home23/api/workers',
      media: '/home23/api/media',
      chatHealth: '/health',
      chatModels: '/api/chat/models',
      chatTurn: '/api/chat/turn',
      chatStream: '/api/chat/stream',
      chatPending: '/api/chat/pending',
      chatStopTurn: '/api/chat/stop-turn',
      chatHistory: '/api/chat/history',
      chatConversations: '/api/chat/conversations',
      chatTurnStatus: '/api/chat/turn-status',
      deviceRegister: '/api/device/register',
      saunaTileData: '/home23/api/tiles/sauna-control/data',
    },
    auth: {
      dashboard: 'none',
      bridge: 'bearer-if-configured',
      queryNotebook: 'required',
      queryNotebookMethods: ['device-bearer', 'same-origin-session'],
    },
    selectedAgent: {
      source: 'settings-agents',
      supported: true,
    },
    query: {
      facade: true,
      directCosmo: false,
      streaming: true,
      availabilityEndpoint: '/home23/api/query/catalog',
      notebookVersion: 1,
      progressSnapshots: true,
      actionTokens: true,
      deviceCredentials: true,
      webSessions: true,
      notificationSubscriptions: true,
      historyRemoval: 'terminal-only',
      exportFormats: ['markdown'],
    },
    chat: {
      turnStatus: true,
      stopByTurnId: true,
      resumePending: true,
    },
    push: {
      registration: true,
      perAgentReceipts: true,
    },
    houseGlobal: {
      sauna: true,
    },
  };
}

function registerClientCapabilitiesRoute(app, options = {}) {
  app.get('/home23/api/client-capabilities', (_req, res) => {
    res.json(buildClientCapabilities(options));
  });
}

module.exports = {
  CONTRACT_VERSION,
  buildClientCapabilities,
  registerClientCapabilitiesRoute,
};
