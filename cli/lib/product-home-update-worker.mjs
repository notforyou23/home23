#!/usr/bin/env node
import { runHomeUpdateOperation } from './product-home-update.js';
// The resident supervisor runs with launchd Umask 077 and this worker inherits
// it. Payload verification requires the manifest's 0755/0644 modes, so start
// from the normal umask; extraction and staging also set modes explicitly.
process.umask(0o022);
const [homeRoot, operationId] = process.argv.slice(2);
await runHomeUpdateOperation({ homeRoot, operationId, requireWorkerAdmission: true });
