import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SignalsModule } from './signals/signals.module';
import { IncidentsModule } from './incidents/incidents.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './common/redis/redis.module';
import { DatabaseModule } from './common/database/database.module';
import { ServicesModule } from './common/services/services.module';
import { WorkersModule } from './workers/workers.module';
import { RateLimiterMiddleware } from './common/middleware/rate-limiter.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServicesModule,
    RedisModule,
    DatabaseModule,
    SignalsModule,
    IncidentsModule,
    DashboardModule,
    HealthModule,
    WorkersModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apply rate limiter only to ingestion endpoint
    consumer
      .apply(RateLimiterMiddleware)
      .forRoutes('signals/ingest');
  }
}



