import { Injectable, NestMiddleware, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../services/metrics.service';

/**
 * Token Bucket Rate Limiter Middleware
 *
 * Algorithm: Token Bucket (via atomic Redis Lua script)
 *
 * Why Token Bucket over Fixed Window:
 * - Allows controlled bursts (assignment requires handling 10k/sec spikes)
 * - No boundary-doubling issue (fixed window can allow 2x at edges)
 * - Smooth rate enforcement over time
 * - Industry standard for API rate limiting (used by Stripe, GitHub, etc.)
 *
 * How it works:
 * - Each client has a "bucket" with max capacity (e.g., 10,000 tokens)
 * - Tokens refill at a steady rate (e.g., 10,000 tokens/sec)
 * - Each request consumes 1 token
 * - If bucket is empty → reject with 429
 * - If tokens available → allow and decrement
 */
@Injectable()
export class RateLimiterMiddleware implements NestMiddleware {
  private readonly bucketCapacity: number;
  private readonly refillRate: number; // tokens per second
  private readonly keyPrefix = 'rl:tb';

  // Lua script for atomic token bucket check + consume
  // This runs atomically in Redis — no race conditions
  private readonly TOKEN_BUCKET_SCRIPT = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local requested = tonumber(ARGV[4])

    -- Get current bucket state
    local bucket = redis.call('hmget', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1])
    local last_refill = tonumber(bucket[2])

    -- Initialize bucket if it doesn't exist
    if tokens == nil then
      tokens = capacity
      last_refill = now
    end

    -- Calculate tokens to add based on elapsed time
    local elapsed = math.max(0, now - last_refill)
    local new_tokens = elapsed * refill_rate
    tokens = math.min(capacity, tokens + new_tokens)

    -- Try to consume tokens
    local allowed = 0
    local remaining = tokens

    if tokens >= requested then
      tokens = tokens - requested
      allowed = 1
      remaining = tokens
    end

    -- Update bucket state
    redis.call('hmset', key, 'tokens', tokens, 'last_refill', now)
    redis.call('expire', key, math.ceil(capacity / refill_rate) + 1)

    return {allowed, math.floor(remaining)}
  `;

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {
    this.bucketCapacity = parseInt(process.env.RATE_LIMIT_BUCKET_CAPACITY || '10000', 10);
    this.refillRate = parseInt(process.env.RATE_LIMIT_REFILL_RATE || '10000', 10);
  }

  async use(req: Request, res: Response, next: NextFunction) {
    const clientId = this.getClientId(req);
    const key = `${this.keyPrefix}:${clientId}`;
    const now = Date.now() / 1000; // seconds with fractional precision

    try {
      const result = await this.redis.client.eval(
        this.TOKEN_BUCKET_SCRIPT,
        1,            // number of KEYS
        key,          // KEYS[1]
        String(this.bucketCapacity),  // ARGV[1] capacity
        String(this.refillRate),       // ARGV[2] refill rate
        String(now),                   // ARGV[3] current time
        '1',                           // ARGV[4] tokens to consume
      ) as [number, number];

      const allowed = result[0] === 1;
      const remaining = result[1];

      // Set rate limit headers (standard)
      res.setHeader('X-RateLimit-Limit', this.bucketCapacity);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
      res.setHeader('X-RateLimit-Policy', `${this.bucketCapacity};w=1;burst=${this.bucketCapacity}`);

      if (!allowed) {
        this.metrics.incrementRateLimitRejections();
        res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          statusCode: 429,
          message: 'Rate limit exceeded. Try again later.',
          retryAfter: 1, // tokens refill continuously
          algorithm: 'token_bucket',
        });
        return;
      }

      next();
    } catch (error) {
      // Fail-open: if Redis is down, allow the request through
      // This prevents Redis outage from blocking all ingestion
      console.error('[RateLimiter] Redis error, failing open:', error);
      next();
    }
  }

  private getClientId(req: Request): string {
    // Use API key header if available, otherwise IP
    return (
      (req.headers['x-api-key'] as string) ||
      req.ip ||
      'unknown'
    );
  }
}

