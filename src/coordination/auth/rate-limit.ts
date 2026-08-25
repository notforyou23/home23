export const AUTH_RATE_LIMIT_POLICIES = Object.freeze({
  pairingIssue: Object.freeze({ limit: 5, windowMs: 60 * 1000 }),
  pairingRedeem: Object.freeze({ limit: 10, windowMs: 15 * 60 * 1000 }),
  refresh: Object.freeze({ limit: 30, windowMs: 60 * 1000 }),
  protectedMutation: Object.freeze({ limit: 120, windowMs: 60 * 1000 }),
});

export type AuthRateLimitPolicyName = keyof typeof AUTH_RATE_LIMIT_POLICIES;

interface RateWindow {
  startedAtMs: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: "rate_limit_exceeded";
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterMs: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  constructor(private readonly maximumWindows = 10_000) {
    if (!Number.isSafeInteger(maximumWindows) || maximumWindows < 1 || maximumWindows > 1_000_000) {
      throw new Error("auth rate-limit capacity is invalid");
    }
  }

  get activeWindowCount(): number {
    return this.windows.size;
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, window] of this.windows) {
      const policyName = key.slice(0, key.indexOf("\0")) as AuthRateLimitPolicyName;
      const policy = AUTH_RATE_LIMIT_POLICIES[policyName];
      if (policy && nowMs >= window.startedAtMs + policy.windowMs) {
        this.windows.delete(key);
      }
    }
  }

  consume(input: {
    policy: AuthRateLimitPolicyName;
    key: string;
    nowMs: number;
  }): RateLimitResult {
    const policy = AUTH_RATE_LIMIT_POLICIES[input.policy];
    if (!policy) throw new Error("unknown auth rate-limit policy");
    if (
      typeof input.key !== "string" ||
      input.key.length < 1 ||
      input.key.length > 256 ||
      input.key.includes("\0")
    ) {
      throw new Error("auth rate-limit key is invalid");
    }
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
      throw new Error("auth rate-limit clock is invalid");
    }
    const mapKey = `${input.policy}\0${input.key}`;
    this.pruneExpired(input.nowMs);
    let window = this.windows.get(mapKey);
    if (!window && this.windows.size >= this.maximumWindows) {
      let resetAtMs = input.nowMs + policy.windowMs;
      for (const [key, active] of this.windows) {
        const policyName = key.slice(0, key.indexOf("\0")) as AuthRateLimitPolicyName;
        const activePolicy = AUTH_RATE_LIMIT_POLICIES[policyName];
        if (activePolicy) resetAtMs = Math.min(resetAtMs, active.startedAtMs + activePolicy.windowMs);
      }
      return {
        allowed: false,
        reason: "rate_limit_exceeded",
        limit: policy.limit,
        remaining: 0,
        resetAtMs,
        retryAfterMs: Math.max(0, resetAtMs - input.nowMs),
      };
    }
    if (!window || input.nowMs >= window.startedAtMs + policy.windowMs) {
      window = { startedAtMs: input.nowMs, count: 0 };
      this.windows.set(mapKey, window);
    }
    const resetAtMs = window.startedAtMs + policy.windowMs;
    if (window.count >= policy.limit) {
      return {
        allowed: false,
        reason: "rate_limit_exceeded",
        limit: policy.limit,
        remaining: 0,
        resetAtMs,
        retryAfterMs: Math.max(0, resetAtMs - input.nowMs),
      };
    }
    window.count += 1;
    return {
      allowed: true,
      limit: policy.limit,
      remaining: policy.limit - window.count,
      resetAtMs,
      retryAfterMs: 0,
    };
  }
}
