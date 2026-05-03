import { Module } from '@nestjs/common';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';
import { WorkflowService } from './workflow/workflow.service';
import { RcaService } from './rca/rca.service';
import { WorkersModule } from '@/workers/workers.module';

@Module({
  imports: [WorkersModule],
  controllers: [IncidentsController],
  providers: [IncidentsService, WorkflowService, RcaService],
  exports: [IncidentsService],
})
export class IncidentsModule {}

