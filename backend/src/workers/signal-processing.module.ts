import { Module } from '@nestjs/common';
import { AuditDispatchService } from './audit-dispatch.service';
import { DebounceService } from './debounce.service';
import { WorkItemService } from './work-item.service';
import { AlertStrategyResolver } from './alerting/alert-strategy.resolver';
import { DlqService } from './dlq.service';
import { SignalProcessor } from './signal.processor';
import { DashboardCacheModule } from './dashboard-cache.module';

@Module({
  imports: [DashboardCacheModule],
  providers: [
    AuditDispatchService,
    DebounceService,
    WorkItemService,
    AlertStrategyResolver,
    DlqService,
    SignalProcessor,
  ],
  exports: [SignalProcessor],
})
export class SignalProcessingModule {}

