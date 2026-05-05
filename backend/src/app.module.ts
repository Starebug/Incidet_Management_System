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
import { RepositoriesModule } from '@/repositories';
import { RateLimiterMiddleware } from './common/middleware/rate-limiter.middleware';
import { SignalsController } from './signals/signals.controller';

const appEnv = process.env.APP_ENV || 'local';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${appEnv}`, '.env'],
    }),
    ServicesModule,
    RedisModule,
    DatabaseModule,
    RepositoriesModule,
    SignalsModule,
    IncidentsModule,
    DashboardModule,
    HealthModule,
    WorkersModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Apply rate limiter to all signal ingestion endpoints, including batch ingest.
    consumer
      .apply(RateLimiterMiddleware)
      .forRoutes(SignalsController);
  }
}



