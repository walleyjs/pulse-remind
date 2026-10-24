/**
 * Recipient Fatigue & Alert Storm Limiter
 * Implements a Leaky Token Bucket algorithm per recipient/tenant.
 */

export interface TokenBucket {
  tokens: number;
  lastRefillUnix: number;
  capacity: number;
  refillRatePerSecond: number;
}

export class RecipientRateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private defaultCapacity: number;
  private defaultRefillRate: number; // tokens per second

  constructor(defaultCapacity = 5, defaultRefillRate = 0.1) {
    this.defaultCapacity = defaultCapacity;
    this.defaultRefillRate = defaultRefillRate;
  }

  private getBucket(recipientKey: string): TokenBucket {
    const nowUnix = Date.now() / 1000;
    let bucket = this.buckets.get(recipientKey);

    if (!bucket) {
      bucket = {
        tokens: this.defaultCapacity,
        lastRefillUnix: nowUnix,
        capacity: this.defaultCapacity,
        refillRatePerSecond: this.defaultRefillRate
      };
      this.buckets.set(recipientKey, bucket);
      return bucket;
    }

    // Refill tokens based on elapsed time
    const elapsed = nowUnix - bucket.lastRefillUnix;
    if (elapsed > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRatePerSecond);
      bucket.lastRefillUnix = nowUnix;
    }

    return bucket;
  }

  consume(recipientKey: string, cost = 1): { allowed: boolean; remainingTokens: number } {
    const bucket = this.getBucket(recipientKey);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remainingTokens: Math.floor(bucket.tokens) };
    }

    return { allowed: false, remainingTokens: Math.floor(bucket.tokens) };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const recipientRateLimiter = new RecipientRateLimiter();
