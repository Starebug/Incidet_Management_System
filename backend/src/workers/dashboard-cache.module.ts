import { Module } from '@nestjs/common';
import { DashboardCacheService } from './dashboard-cache.service';

@Module({
  providers: [DashboardCacheService],
  exports: [DashboardCacheService],
})
export class DashboardCacheModule {}

