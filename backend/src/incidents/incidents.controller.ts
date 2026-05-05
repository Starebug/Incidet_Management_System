import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { IncidentsService } from './incidents.service';
import { WorkflowService } from './workflow/workflow.service';
import { RcaService } from './rca/rca.service';
import { UpdateStatusDto } from './dto/update-status.dto';
import { CreateRcaDto } from './dto/create-rca.dto';

@Controller('incidents')
export class IncidentsController {
  constructor(
    private readonly incidentsService: IncidentsService,
    private readonly workflowService: WorkflowService,
    private readonly rcaService: RcaService,
  ) {}

  /**
   * GET /api/incidents
   * List incidents with optional filters and pagination.
   */
  @Get()
  async listIncidents(
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('component_id') componentId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const filters = {
      status: status || undefined,
      severity: severity || undefined,
      componentId: componentId || undefined,
      page: parseInt(page || '1', 10),
      limit: Math.min(parseInt(limit || '50', 10), 100),
    };

    return this.incidentsService.listIncidents(filters);
  }

  /**
   * GET /api/incidents/:id
   * Get incident details by external_id.
   */
  @Get(':id')
  async getIncident(@Param('id') id: string) {
    const incident = await this.incidentsService.getIncidentById(id);
    if (!incident) {
      throw new HttpException('Incident not found', HttpStatus.NOT_FOUND);
    }
    return incident;
  }

  /**
   * GET /api/incidents/:id/signals
   * Get raw signals linked to this incident (from MongoDB).
   * Audit/history browsing is eventually consistent and may briefly lag writes.
   */
  @Get(':id/signals')
  async getIncidentSignals(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = parseInt(page || '1', 10);
    const limitNum = Math.min(parseInt(limit || '50', 10), 200);

    return this.incidentsService.getIncidentSignals(id, pageNum, limitNum);
  }

  /**
   * GET /api/incidents/:id/history
   * Get status transition history.
   */
  @Get(':id/history')
  async getIncidentHistory(@Param('id') id: string) {
    return this.incidentsService.getStatusHistory(id);
  }

  /**
   * PATCH /api/incidents/:id/status
   * Update incident status (workflow transition).
   */
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    try {
      const result = await this.workflowService.transition(id, dto);
      return {
        statusCode: 200,
        message: `Status updated to ${dto.status}`,
        incident: result,
      };
    } catch (error: any) {
      if (error.message?.includes('Invalid transition')) {
        throw new HttpException(
          { statusCode: 422, message: error.message },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (error.message?.includes('RCA')) {
        throw new HttpException(
          { statusCode: 422, message: error.message },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw error;
    }
  }

  /**
   * POST /api/incidents/:id/rca
   * Submit Root Cause Analysis for an incident.
   */
  @Post(':id/rca')
  async submitRca(
    @Param('id') id: string,
    @Body() dto: CreateRcaDto,
  ) {
    try {
      const result = await this.rcaService.submitRca(id, dto);
      return {
        statusCode: 201,
        message: 'RCA submitted successfully',
        rca: result,
      };
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        throw new HttpException(
          { statusCode: 404, message: error.message },
          HttpStatus.NOT_FOUND,
        );
      }
      if (error.message?.includes('already exists')) {
        throw new HttpException(
          { statusCode: 409, message: error.message },
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /**
   * GET /api/incidents/:id/rca
   * Get RCA for an incident.
   */
  @Get(':id/rca')
  async getRca(@Param('id') id: string) {
    const rca = await this.rcaService.getRcaByIncidentId(id);
    if (!rca) {
      throw new HttpException('RCA not found', HttpStatus.NOT_FOUND);
    }
    return rca;
  }
}

