/**
 * Home23 — Engine WebSocket Event Listener
 *
 * Connects to the COSMO engine's realtime WebSocket server and subscribes
 * to cognitive events (thoughts, dreams, state changes). For Step 2, events
 * are logged. In later steps, the harness can react to them.
 */

import WebSocket from 'ws';

const SUBSCRIBED_EVENTS = [
  'thought_generated',
  'dream_started',
  'dream_phase',
  'cognitive_state_changed',
  'goal_created',
  'goal_completed',
  'agent_completed',
  'sleep_triggered',
  'wake_triggered',
  'cycle_complete',
];

export class EngineEventListener {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(engineWsPort: number, reconnectMs = 5000) {
    this.url = `ws://localhost:${engineWsPort}`;
    this.reconnectMs = reconnectMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log(`[engine-events] Connected to engine WS at ${this.url}`);
      this.ws!.send(JSON.stringify({
        type: 'subscribe',
        events: SUBSCRIBED_EVENTS,
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribed') {
          console.log(`[engine-events] Subscribed to ${msg.events?.length ?? 0} event types`);
        } else if (msg.type === 'connected') {
          // Welcome message — ignore
        } else if (msg.type === 'pong') {
          // Heartbeat response — ignore
        } else {
          // Log cognitive events
          const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
          console.log(`[engine-events] ${msg.type}${ts ? ` (${ts})` : ''}`);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      if (!this.stopped) {
        console.log('[engine-events] Connection closed, reconnecting...');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[engine-events] WS error: ${err.message}`);
      // close event will trigger reconnect
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
  }
}
