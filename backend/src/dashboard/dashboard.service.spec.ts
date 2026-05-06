import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  function makeService() {
    const workItemRepo = {
      findDashboardSummariesByExternalIds: jest.fn(),
      findLiveFeed: jest.fn(),
      getStats: jest.fn(),
    };

    const dashboardStateRepo = {
      getIdsByStatus: jest.fn(),
      getAllActiveIds: jest.fn(),
      loadIncidentSummaries: jest.fn(),
      warmCache: jest.fn().mockResolvedValue(undefined),
      removeFromAllStateSets: jest.fn().mockResolvedValue(undefined),
    };

    const service = new DashboardService(workItemRepo as any, dashboardStateRepo as any);
    return { service, workItemRepo, dashboardStateRepo };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('repairs partial cache hits by backfilling missing summaries from Postgres', async () => {
    const { service, workItemRepo, dashboardStateRepo } = makeService();

    dashboardStateRepo.getIdsByStatus.mockResolvedValue(['id-1', 'id-2']);
    dashboardStateRepo.loadIncidentSummaries.mockResolvedValue({
      incidents: [
        {
          external_id: 'id-1',
          component_id: 'API_GATEWAY_01',
          service_type: 'API',
          severity: 'P1',
          status: 'OPEN',
          first_signal_at: '2026-05-05T00:00:00.000Z',
          last_signal_at: '2026-05-05T00:00:00.000Z',
          signal_count: '1',
          updated_at: '2026-05-05T00:00:00.000Z',
        },
      ],
      missingIds: ['id-2'],
    });
    workItemRepo.findDashboardSummariesByExternalIds.mockResolvedValue([
      {
        external_id: 'id-2',
        component_id: 'CACHE_CLUSTER_01',
        service_type: 'CACHE',
        severity: 'P2',
        status: 'OPEN',
        first_signal_at: '2026-05-05T00:01:00.000Z',
        last_signal_at: '2026-05-05T00:02:00.000Z',
        signal_count: 3,
        updated_at: '2026-05-05T00:02:00.000Z',
      },
    ]);

    const result = await service.getLiveFeed('OPEN');

    expect(workItemRepo.findDashboardSummariesByExternalIds).toHaveBeenCalledWith(['id-2'], 'OPEN');
    expect(dashboardStateRepo.removeFromAllStateSets).toHaveBeenCalledWith(['id-2']);
    expect(dashboardStateRepo.warmCache).toHaveBeenCalledWith([
      expect.objectContaining({ external_id: 'id-2' }),
    ]);
    expect(result.source).toBe('cache+backfill');
    expect(result.incidents.map((incident: any) => incident.external_id)).toEqual(['id-1', 'id-2']);
  });

  it('prunes unresolved stale ids and falls back to Postgres when cache entries cannot be repaired', async () => {
    const { service, workItemRepo, dashboardStateRepo } = makeService();

    dashboardStateRepo.getIdsByStatus.mockResolvedValue(['id-1']);
    dashboardStateRepo.loadIncidentSummaries.mockResolvedValue({
      incidents: [],
      missingIds: ['id-1'],
    });
    workItemRepo.findDashboardSummariesByExternalIds.mockResolvedValue([]);
    workItemRepo.findLiveFeed.mockResolvedValue([
      {
        external_id: 'id-2',
        component_id: 'DB_PRIMARY_01',
        service_type: 'RDBMS',
        severity: 'P0',
        status: 'OPEN',
        first_signal_at: '2026-05-05T00:00:00.000Z',
        last_signal_at: '2026-05-05T00:03:00.000Z',
        signal_count: 5,
        updated_at: '2026-05-05T00:03:00.000Z',
      },
    ]);

    const result = await service.getLiveFeed('OPEN');

    expect(dashboardStateRepo.removeFromAllStateSets).toHaveBeenCalledWith(['id-1']);
    expect(workItemRepo.findLiveFeed).toHaveBeenCalledWith('OPEN', 100);
    expect(result.source).toBe('postgres');
    expect(result.incidents).toHaveLength(1);
  });

  it('treats wrong-status cached summaries as inconsistent and repairs them through Postgres', async () => {
    const { service, workItemRepo, dashboardStateRepo } = makeService();

    dashboardStateRepo.getIdsByStatus.mockResolvedValue(['id-1']);
    dashboardStateRepo.loadIncidentSummaries.mockResolvedValue({
      incidents: [
        {
          external_id: 'id-1',
          component_id: 'API_GATEWAY_01',
          service_type: 'API',
          severity: 'P1',
          status: 'INVESTIGATING',
          first_signal_at: '2026-05-05T00:00:00.000Z',
          last_signal_at: '2026-05-05T00:05:00.000Z',
          signal_count: '2',
          updated_at: '2026-05-05T00:05:00.000Z',
        },
      ],
      missingIds: [],
    });
    workItemRepo.findDashboardSummariesByExternalIds.mockResolvedValue([
      {
        external_id: 'id-1',
        component_id: 'API_GATEWAY_01',
        service_type: 'API',
        severity: 'P1',
        status: 'OPEN',
        first_signal_at: '2026-05-05T00:00:00.000Z',
        last_signal_at: '2026-05-05T00:05:00.000Z',
        signal_count: 2,
        updated_at: '2026-05-05T00:05:00.000Z',
      },
    ]);

    const result = await service.getLiveFeed('OPEN');

    expect(dashboardStateRepo.removeFromAllStateSets).toHaveBeenCalledWith(['id-1']);
    expect(result.source).toBe('cache+backfill');
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0].status).toBe('OPEN');
  });

  it('serves CLOSED incidents directly from Postgres without reading or warming the cache', async () => {
    const { service, workItemRepo, dashboardStateRepo } = makeService();

    workItemRepo.findLiveFeed.mockResolvedValue([
      {
        external_id: 'id-9',
        component_id: 'API_GATEWAY_01',
        service_type: 'API',
        severity: 'P2',
        status: 'CLOSED',
        first_signal_at: '2026-05-05T00:00:00.000Z',
        last_signal_at: '2026-05-05T00:08:00.000Z',
        signal_count: 7,
        updated_at: '2026-05-05T00:15:00.000Z',
      },
    ]);

    const result = await service.getLiveFeed('CLOSED');

    expect(workItemRepo.findLiveFeed).toHaveBeenCalledWith('CLOSED', 100);
    expect(dashboardStateRepo.getIdsByStatus).not.toHaveBeenCalled();
    expect(dashboardStateRepo.getAllActiveIds).not.toHaveBeenCalled();
    expect(dashboardStateRepo.loadIncidentSummaries).not.toHaveBeenCalled();
    expect(dashboardStateRepo.warmCache).not.toHaveBeenCalled();
    expect(result.source).toBe('postgres');
    expect(result.status).toBe('CLOSED');
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0].status).toBe('CLOSED');
  });
});


