import { readFileSync } from 'node:fs';
import { connect, ClientHttp2Session } from 'node:http2';
import jwt from 'jsonwebtoken';
import type { ApnsConfig, PushPayload } from './types.js';

/**
 * Minimal APNs HTTP/2 client. Manages a single HTTP/2 session (reused across sends)
 * and a cached JWT provider token (refreshed every 50 minutes — Apple allows 60 max).
 */
export class ApnsClient {
  private session: ClientHttp2Session | null = null;
  private currentHost: string | null = null;
  private cachedToken: { value: string; issuedAt: number } | null = null;
  private keyPem: string;

  constructor(private config: ApnsConfig) {
    this.keyPem = readFileSync(config.key_path, 'utf8');
  }

  private getProviderToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && (now - this.cachedToken.issuedAt) < 50 * 60) {
      return this.cachedToken.value;
    }
    const token = jwt.sign({ iss: this.config.team_id, iat: now }, this.keyPem, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: this.config.key_id } as jwt.JwtHeader,
    });
    this.cachedToken = { value: token, issuedAt: now };
    return token;
  }

  private hostFor(env: 'sandbox' | 'production'): string {
    return env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  }

  private async ensureSession(host: string): Promise<ClientHttp2Session> {
    if (this.session && this.currentHost === host && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    if (this.session) { try { this.session.close(); } catch {} this.session = null; }
    const s = connect(host);
    this.session = s;
    this.currentHost = host;
    s.on('error', () => { this.session = null; });
    s.on('close', () => { this.session = null; });
    return s;
  }

  /**
   * Send a push. Resolves to the APNs response status.
   * On 410 Gone, caller should invalidate the device token.
   */
  async send(deviceToken: string, payload: PushPayload, env?: 'sandbox' | 'production'): Promise<{ status: number; apnsId?: string; reason?: string }> {
    const targetEnv = env ?? this.config.default_env;
    const host = this.hostFor(targetEnv);
    const session = await this.ensureSession(host);

    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload));
      const req = session.request({
        ':method': 'POST',
        ':scheme': 'https',
        ':path': `/3/device/${deviceToken}`,
        ':authority': new URL(host).host,
        'authorization': `bearer ${this.getProviderToken()}`,
        'apns-topic': this.config.bundle_id,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
        'content-length': body.length.toString(),
      });

      let status = 0;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];

      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
        apnsId = headers['apns-id'] as string | undefined;
      });
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let reason: string | undefined;
        if (status >= 400 && chunks.length) {
          try { reason = JSON.parse(Buffer.concat(chunks).toString()).reason; } catch {}
        }
        resolve({ status, apnsId, reason });
      });
      req.on('error', reject);

      req.write(body);
      req.end();
    });
  }

  close(): void {
    if (this.session) { try { this.session.close(); } catch {} this.session = null; }
  }
}
