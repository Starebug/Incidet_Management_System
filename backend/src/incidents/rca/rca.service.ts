import { Injectable } from '@nestjs/common';
import { WorkItemRepository } from '@/repositories';
import { CreateRcaDto } from '../dto/create-rca.dto';

/**
 * RCA Service
 * Manages Root Cause Analysis submission and validation.
 * Never calls a DB driver directly — all data access via WorkItemRepository.
 */
@Injectable()
export class RcaService {
  constructor(private readonly workItemRepo: WorkItemRepository) {}

  /**
   * Submit RCA for an incident.
   * Validates incident exists and RCA doesn't already exist.
   * Computes MTTR from first_signal_at to incident_end.
   */
  async submitRca(externalId: string, dto: CreateRcaDto) {
    // Get work item
    const workItem = await this.workItemRepo.findByExternalId(externalId);

    if (!workItem) {
      throw new Error('Incident not found');
    }

    // Check if RCA already exists
    const existingRca = await this.workItemRepo.findRcaByWorkItemId(workItem.id);

    if (existingRca) {
      throw new Error('RCA already exists for this incident. Use PUT to update.');
    }

    // Validate dates
    const incidentStart = new Date(dto.incident_start);
    const incidentEnd = new Date(dto.incident_end);

    if (incidentEnd < incidentStart) {
      throw new Error('incident_end must be greater than or equal to incident_start');
    }

    // Calculate MTTR
    const firstSignalAt = new Date(workItem.first_signal_at);
    const mttrSeconds = Math.floor((incidentEnd.getTime() - firstSignalAt.getTime()) / 1000);

    // Insert RCA
    const rcaRecord = await this.workItemRepo.insertRca(
      workItem.id,
      dto.incident_start,
      dto.incident_end,
      dto.root_cause_category,
      dto.fix_applied,
      dto.prevention_steps,
      dto.created_by,
    );

    // Update MTTR on work item
    await this.workItemRepo.updateMttr(workItem.id, mttrSeconds);

    return {
      ...rcaRecord,
      mttr_seconds: mttrSeconds,
      incident_external_id: externalId,
    };
  }

  /**
   * Get RCA by incident external_id.
   */
  async getRcaByIncidentId(externalId: string) {
    return this.workItemRepo.findRcaByExternalId(externalId);
  }
}
