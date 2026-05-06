import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServicesModule } from './common/services/services.module';
import { RedisModule } from './common/redis/redis.module';
import { DatabaseModule } from './common/database/database.module';
import { RepositoriesModule } from '@/repositories';
import { AuditWorkerModule } from './workers/audit-worker.module';

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
    AuditWorkerModule,
  ],
})
export class AppAuditWorkerModule {}

