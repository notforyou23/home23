/**
 * Event Logger - Simple append-only event log
 * Writes events to events.jsonl for SSE streaming
 */

const fs = require('fs');
const path = require('path');

class EventLogger {
  constructor(runPath) {
    this.runPath = runPath;
    this.filePath = path.join(runPath, 'events.jsonl');
    this.stream = null;
    this.eventCount = 0;
  }

  initialize(cleanStart = false) {
    // Clear file on clean start
    if (cleanStart && fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
    
    // Open append stream
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.log({ type: 'session_start', timestamp: Date.now() });
  }

  log(event) {
    if (!this.stream) return;
    
    const entry = {
      ...event,
      eventId: ++this.eventCount,
      timestamp: event.timestamp || Date.now()
    };
    
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  // Convenience methods matching event emitter API
  emitThought(data) { this.log({ type: 'thought_generated', ...data }); }
  emitCycle(data) { this.log({ type: 'cycle_start', ...data }); }
  emitGoal(data) { this.log({ type: 'goal_created', ...data }); }
  emitAgent(data) { this.log({ type: 'agent_spawned', ...data }); }
  emitWebSearch(data) { this.log({ type: 'web_search', ...data }); }
  emitCode(data) { this.log({ type: 'code_generation', ...data }); }
  emit(type, data) { this.log({ type, ...data }); }

  close() {
    if (this.stream) {
      this.log({ type: 'session_end', totalEvents: this.eventCount });
      this.stream.end();
    }
  }
}

module.exports = { EventLogger };
