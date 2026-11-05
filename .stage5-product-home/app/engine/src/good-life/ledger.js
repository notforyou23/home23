'use strict';

const fs = require('fs');
const path = require('path');

class GoodLifeLedger {
  constructor({ brainDir, logger } = {}) {
    if (!brainDir) throw new Error('GoodLifeLedger requires brainDir');
    this.brainDir = brainDir;
    this.logger = logger || console;
    this.ledgerPath = path.join(brainDir, 'good-life-ledger.jsonl');
    this.statePath = path.join(brainDir, 'good-life-state.json');
  }

  append(evaluation) {
    try {
      fs.mkdirSync(this.brainDir, { recursive: true });
      fs.appendFileSync(this.ledgerPath, JSON.stringify(evaluation) + '\n');
      fs.writeFileSync(this.statePath, JSON.stringify(evaluation, null, 2));
      return true;
    } catch (err) {
      this.logger.warn?.('[good-life] ledger write failed:', err?.message || err);
      return false;
    }
  }
}

module.exports = { GoodLifeLedger };
