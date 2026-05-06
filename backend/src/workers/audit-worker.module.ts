import { Module } from '@nestjs/common';
import { AuditStreamConsumer } from './audit-stream.consumer';
import { AuditPersistenceProcessor } from './audit-persistence.processor';
import { DlqService } from './dlq.service';

@Module({
  providers: [AuditStreamConsumer, AuditPersistenceProcessor, DlqService],
  exports: [AuditStreamConsumer],
})
export class AuditWorkerModule {}

