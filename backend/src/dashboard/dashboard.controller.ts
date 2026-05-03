import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * GET /api/dashboard/live?status=OPEN|INVESTIGATING|RESOLVED
   * Returns incidents for the given status tab, sorted by severity.
   * Uses Redis state-partitioned cache with Postgres fallback.
   */
  @Get('live')
  async getLiveFeed(@Query('status') status?: string) {
    const validStatuses = ['OPEN', 'INVESTIGATING', 'RESOLVED'];
    const resolvedStatus = validStatuses.includes(status?.toUpperCase() || '')
      ? status!.toUpperCase()
      : undefined; // undefined = all active
    return this.dashboardService.getLiveFeed(resolvedStatus);
  }

  /**
   * GET /api/dashboard/stats
   * Aggregated stats (counts by severity/status, MTTR averages).
   */
  @Get('stats')
  async getStats() {
    return this.dashboardService.getStats();
  }
}
