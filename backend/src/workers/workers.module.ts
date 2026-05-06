import { Module } from '@nestjs/common';
import { DashboardCacheModule } from './dashboard-cache.module';
import { SignalProcessingModule } from './signal-processing.module';
import { SignalWorkerModule } from './signal-worker.module';
import { AuditWorkerModule } from './audit-worker.module';

@Module({
  imports: [
    DashboardCacheModule,
    SignalProcessingModule,
    SignalWorkerModule,
    AuditWorkerModule,
  ],
  exports: [DashboardCacheModule, SignalWorkerModule, AuditWorkerModule],
})
export class WorkersModule {}
