const fs = require('fs');
const path = require('path');

const CONTRACT_VERSION = '2026.06.26';

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
  const packageVersion = options.packageVersion || readPackageVersion(options.home23Root) || '0.6.0';

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
      queryStreaming: false,
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
    },
    selectedAgent: {
      source: 'settings-agents',
      supported: true,
    },
    query: {
      facade: true,
      directCosmo: false,
      streaming: false,
      availabilityEndpoint: '/home23/api/query/catalog',
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
