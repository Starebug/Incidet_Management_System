import { Module } from '@nestjs/common';
import { SignalStreamConsumer } from './signal-stream.consumer';
import { SignalProcessor } from './signal.processor';
import { DebounceService } from './debounce.service';
import { WorkItemService } from './work-item.service';
import { AlertStrategyResolver } from './alerting/alert-strategy.resolver';
import { DashboardCacheService } from './dashboard-cache.service';
import { DlqService } from './dlq.service';

@Module({
  providers: [
    SignalStreamConsumer,
    SignalProcessor,
    DebounceService,
    WorkItemService,
    AlertStrategyResolver,
    DashboardCacheService,
    DlqService,
  ],
  exports: [SignalStreamConsumer],
})
export class WorkersModule {}

