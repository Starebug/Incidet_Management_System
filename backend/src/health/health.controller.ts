import { Controller, Get } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { PostgresService } from '../common/database/postgres.service';
import { MongoService } from '../common/database/mongo.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly redis: RedisService,
    private readonly pg: PostgresService,
    private readonly mongo: MongoService,
  ) {}

  /**
   * GET /api/health
   * Returns health status of all dependencies.
   */
  @Get()
  async check() {
    const [redisOk, pgOk, mongoOk] = await Promise.all([
      this.redis.ping(),
      this.pg.ping(),
      this.mongo.ping(),
    ]);

    const status = redisOk && pgOk && mongoOk ? 'healthy' : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies: {
        redis: redisOk ? 'up' : 'down',
        postgres: pgOk ? 'up' : 'down',
        mongodb: mongoOk ? 'up' : 'down',
      },
      memory: {
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };
  }
}

