import { Module } from '@nestjs/common';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';
import { WorkflowService } from './workflow/workflow.service';
import { RcaService } from './rca/rca.service';
import { DashboardCacheModule } from '@/workers/dashboard-cache.module';

@Module({
  imports: [DashboardCacheModule],
  controllers: [IncidentsController],
  providers: [IncidentsService, WorkflowService, RcaService],
  exports: [IncidentsService],
})
export class IncidentsModule {}

