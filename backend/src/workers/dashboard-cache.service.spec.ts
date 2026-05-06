import { DashboardCacheService } from './dashboard-cache.service';

describe('DashboardCacheService', () => {
  function makeService() {
	const dashboardStateRepo = {
	  addNewIncident: jest.fn().mockResolvedValue(undefined),
	  upsertActiveIncidentProjection: jest.fn().mockResolvedValue(undefined),
	  moveIncidentState: jest.fn().mockResolvedValue(undefined),
	  removeFromAllStateSets: jest.fn().mockResolvedValue(undefined),
	  deleteIncidentSummary: jest.fn().mockResolvedValue(undefined),
	};

	const workItemRepo = {
	  findDashboardSummaryByExternalId: jest.fn(),
	};

	const service = new DashboardCacheService(dashboardStateRepo as any, workItemRepo as any);
	return { service, dashboardStateRepo, workItemRepo };
  }

  afterEach(() => {
	jest.clearAllMocks();
  });

  it('refreshes an existing active incident projection from Postgres after another signal arrives', async () => {
	const { service, dashboardStateRepo, workItemRepo } = makeService();

	workItemRepo.findDashboardSummaryByExternalId.mockResolvedValue({
	  external_id: 'incident-1',
	  component_id: 'API_GATEWAY_01',
	  service_type: 'API',
	  severity: 'P1',
	  status: 'OPEN',
	  first_signal_at: new Date('2026-05-05T00:00:00.000Z'),
	  last_signal_at: new Date('2026-05-05T00:05:00.000Z'),
	  signal_count: 4,
	  updated_at: new Date('2026-05-05T00:05:00.000Z'),
	});

	await service.onIncidentUpdated('incident-1');

	expect(dashboardStateRepo.upsertActiveIncidentProjection).toHaveBeenCalledWith(
	  'OPEN',
	  'incident-1',
	  expect.objectContaining({
		signal_count: '4',
		last_signal_at: '2026-05-05T00:05:00.000Z',
	  }),
	  'P1',
	);
  });

  it('removes closed incidents from the active dashboard projection explicitly', async () => {
	const { service, dashboardStateRepo } = makeService();

	await service.onStatusChanged('incident-1', 'RESOLVED', 'CLOSED', 'P1');

	expect(dashboardStateRepo.moveIncidentState).toHaveBeenCalledWith(
	  'incident-1',
	  'RESOLVED',
	  'CLOSED',
	  null,
	);
  });

  it('drops stale Redis projection state when an incident summary no longer exists in Postgres', async () => {
	const { service, dashboardStateRepo, workItemRepo } = makeService();

	workItemRepo.findDashboardSummaryByExternalId.mockResolvedValue(null);

	await service.onIncidentUpdated('incident-1');

	expect(dashboardStateRepo.removeFromAllStateSets).toHaveBeenCalledWith(['incident-1']);
	expect(dashboardStateRepo.deleteIncidentSummary).toHaveBeenCalledWith('incident-1');
  });
});

