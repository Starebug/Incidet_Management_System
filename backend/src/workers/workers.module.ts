import { Module } from '@nestjs/common';
import { SignalStreamConsumer } from './signal-stream.consumer';
import { SignalProcessor } from './signal.processor';
import { AuditStreamConsumer } from './audit-stream.consumer';
import { AuditPersistenceProcessor } from './audit-persistence.processor';
import { AuditDispatchService } from './audit-dispatch.service';
import { DebounceService } from './debounce.service';
import { WorkItemService } from './work-item.service';
import { AlertStrategyResolver } from './alerting/alert-strategy.resolver';
import { DashboardCacheService } from './dashboard-cache.service';
import { DlqService } from './dlq.service';

@Module({
  providers: [
    SignalStreamConsumer,
    SignalProcessor,
    AuditStreamConsumer,
    AuditPersistenceProcessor,
    AuditDispatchService,
    DebounceService,
    WorkItemService,
    AlertStrategyResolver,
    DashboardCacheService,
    DlqService,
  ],
  exports: [SignalStreamConsumer, DashboardCacheService],
})
export class WorkersModule {}
