import { Injectable } from '@nestjs/common';
import { WorkItemRepository, CreateWorkItemParams } from '@/repositories';

/**
 * WorkItemService
 *
 * Manages work_items lifecycle for the worker.
 * Delegates all data access to WorkItemRepository.
 * No direct DB driver calls.
 */
@Injectable()
export class WorkItemService {
  constructor(private readonly workItemRepo: WorkItemRepository) {}

  /**
   * Create a new work item with initial OPEN status + status history entry.
   * Runs in a single transaction.
   */
  async create(params: CreateWorkItemParams): Promise<void> {
    return this.workItemRepo.create(params);
  }

  /**
   * Add a signal to an existing work item.
   * Increments signal_count and updates last_signal_at.
   */
  async addSignal(externalId: string, signalTime: Date): Promise<void> {
    return this.workItemRepo.addSignal(externalId, signalTime);
  }

  /**
   * Find active (non-CLOSED) work item for a given component.
   * Useful for post-debounce-window reuse of open incidents.
   */
  async findActiveByComponent(componentId: string): Promise<{ external_id: string } | null> {
    return this.workItemRepo.findActiveByComponent(componentId);
  }
}
