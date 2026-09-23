#!/usr/bin/env node
import { runHomeUpdateOperation } from './product-home-update.js';
const [homeRoot, operationId] = process.argv.slice(2);
await runHomeUpdateOperation({ homeRoot, operationId });
