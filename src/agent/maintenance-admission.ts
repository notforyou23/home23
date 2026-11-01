/** Short, expiring admission fence owned by an independent maintenance worker. */
export class MaintenanceAdmission {
  private lease?: { id: string; expiresAt: number };
  constructor(private readonly now: () => number = Date.now) {}
  current() {
    if (this.lease && this.lease.expiresAt <= this.now()) this.lease = undefined;
    return this.lease ? { ...this.lease } : null;
  }
  acquire(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid maintenance lease');
    const current = this.current();
    if (current && current.id !== id) throw new Error('Another maintenance lease is active');
    this.lease = { id, expiresAt: this.now() + 60_000 };
    return this.current();
  }
  release(id: string) {
    if (this.current()?.id === id) this.lease = undefined;
  }
  assertAccepting() {
    if (this.current()) throw Object.assign(new Error('Resident maintenance in progress; retry shortly'), { code: 'resident_maintenance' });
  }
}
