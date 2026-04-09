/**
 * Event Logger - Persistent event log for SSE streaming
 * Extends COSMOEventEmitter but writes to file instead of emitting
 */

const fs = require('fs');
const path = require('path');
const { COSMOEventEmitter } = require('./event-emitter');

class EventLogger extends COSMOEventEmitter {
  constructor(runPath) {
    super();
    this.runPath = runPath;
    this.filePath = path.join(runPath, 'events.jsonl');
    this.stream = null;
  }

  initialize(cleanStart = false) {
    if (cleanStart && fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
    
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this._writeToFile({ type: 'session_start', timestamp: Date.now(), eventId: 0 });
  }

  // Override _emit to write to file instead of emitting events
  _emit(type, data) {
    if (!this.enabled) return;

    this.eventCount++;
    const event = {
      type,
      timestamp: Date.now(),
      eventId: this.eventCount,
      ...data
    };

    this._writeToFile(event);
  }

  _writeToFile(event) {
    if (this.stream) {
      this.stream.write(JSON.stringify(event) + '\n');
      // Force flush for immediate SSE delivery
      if (this.stream.flush) {
        this.stream.flush();
      }
    }
  }

  close() {
    if (this.stream) {
      this._writeToFile({ type: 'session_end', timestamp: Date.now(), eventId: this.eventCount + 1 });
      this.stream.end();
    }
  }
}

module.exports = { EventLogger };
