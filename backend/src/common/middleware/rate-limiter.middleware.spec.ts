import { RateLimiterMiddleware } from './rate-limiter.middleware';

describe('RateLimiterMiddleware', () => {
  function makeMiddleware() {
    const redis = {
      control: {
        eval: jest.fn(),
      },
    };

    const metrics = {
      incrementRateLimitRejections: jest.fn(),
    };

    const middleware = new RateLimiterMiddleware(redis as any, metrics as any);
    return { middleware, redis, metrics };
  }

  function makeResponse() {
    return {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('consumes one token per signal in a batch request', async () => {
    const { middleware, redis } = makeMiddleware();
    const req = {
      headers: {},
      ip: '127.0.0.1',
      body: {
        signals: [{ id: 1 }, { id: 2 }, { id: 3 }],
      },
    } as any;
    const res = makeResponse() as any;
    const next = jest.fn();

    redis.control.eval.mockResolvedValue([1, 9997]);

    await middleware.use(req, res, next);

    expect(redis.control.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'rl:tb:127.0.0.1',
      '10000',
      '10000',
      expect.any(String),
      '3',
    );
    expect(next).toHaveBeenCalled();
  });

  it('rejects when the bucket does not have enough tokens for the whole batch', async () => {
    const { middleware, redis, metrics } = makeMiddleware();
    const req = {
      headers: {},
      ip: '127.0.0.1',
      body: {
        signals: new Array(4).fill({ ok: true }),
      },
    } as any;
    const res = makeResponse() as any;
    const next = jest.fn();

    redis.control.eval.mockResolvedValue([0, 2]);

    await middleware.use(req, res, next);

    expect(metrics.incrementRateLimitRejections).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 429,
      algorithm: 'token_bucket',
    }));
    expect(next).not.toHaveBeenCalled();
  });
});


