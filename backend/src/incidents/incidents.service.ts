import { Injectable } from '@nestjs/common';
import { WorkItemRepository } from '@/repositories';
import { SignalRepository } from '@/repositories';

interface ListFilters {
  status?: string;
  severity?: string;
  componentId?: string;
  page: number;
  limit: number;
}

@Injectable()
export class IncidentsService {
  constructor(
    private readonly workItemRepo: WorkItemRepository,
    private readonly signalRepo: SignalRepository,
  ) {}

  /**
   * List incidents with filtering and pagination.
   */
  async listIncidents(filters: ListFilters) {
    const { rows, total } = await this.workItemRepo.findAll(filters);

    return {
      data: rows,
      pagination: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  }

  /**
   * Get a single incident by external_id.
   */
  async getIncidentById(externalId: string) {
    return this.workItemRepo.findByExternalId(externalId);
  }

  /**
   * Get internal ID by external_id (for joins).
   */
  async getInternalId(externalId: string): Promise<number | null> {
    return this.workItemRepo.getInternalId(externalId);
  }

  /**
   * Get raw signals from MongoDB for a given incident.
   */
  async getIncidentSignals(externalId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { data, total } = await this.signalRepo.findByWorkItemId(externalId, skip, limit);

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get status transition history for an incident.
   */
  async getStatusHistory(externalId: string) {
    const rows = await this.workItemRepo.findStatusHistory(externalId);
    return { data: rows };
  }
}
