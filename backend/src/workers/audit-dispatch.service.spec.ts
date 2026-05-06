import { AuditDispatchService } from './audit-dispatch.service';

describe('AuditDispatchService', () => {
  const originalKey = process.env.AUDIT_STREAM_KEY;
  const originalMaxLength = process.env.AUDIT_STREAM_MAX_LENGTH;

  beforeEach(() => {
    process.env.AUDIT_STREAM_KEY = 'signals:audit:test';
    process.env.AUDIT_STREAM_MAX_LENGTH = '500';
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.AUDIT_STREAM_KEY;
    } else {
      process.env.AUDIT_STREAM_KEY = originalKey;
    }

    if (originalMaxLength === undefined) {
      delete process.env.AUDIT_STREAM_MAX_LENGTH;
    } else {
      process.env.AUDIT_STREAM_MAX_LENGTH = originalMaxLength;
    }

    jest.clearAllMocks();
  });

  it('publishes to the audit stream only when the ledger says enqueue is required', async () => {
    const auditLedger = {
      schedule: jest.fn()
        .mockResolvedValueOnce({ disposition: 'ENQUEUE' })
        .mockResolvedValueOnce({ disposition: 'ALREADY_SCHEDULED' })
        .mockResolvedValueOnce({ disposition: 'ALREADY_PERSISTED' }),
    };

    const xadd = jest.fn().mockResolvedValue('1-0');
    const redis = {
      queue: { xadd },
    };

    const service = new AuditDispatchService(auditLedger as any, redis as any);
    const payload = {
      signal_id: 'sig-1',
      component_id: 'COMPONENT_A',
      service_type: 'API',
      severity: 'P1',
      event_ts: '2026-05-05T00:00:00.000Z',
      payload: { ok: true },
      trace_id: 'trace-1',
      received_at: '2026-05-05T00:00:01.000Z',
      work_item_external_id: '11111111-1111-1111-1111-111111111111',
    };

    await service.schedule(payload);
    await service.schedule(payload);
    await service.schedule(payload);

    expect(auditLedger.schedule).toHaveBeenCalledTimes(3);
    expect(xadd).toHaveBeenCalledTimes(1);
    expect(xadd).toHaveBeenCalledWith(
      'signals:audit:test',
      'MAXLEN',
      '~',
      '500',
      '*',
      'signal_id', 'sig-1',
      'component_id', 'COMPONENT_A',
      'service_type', 'API',
      'severity', 'P1',
      'event_ts', '2026-05-05T00:00:00.000Z',
      'payload', JSON.stringify({ ok: true }),
      'trace_id', 'trace-1',
      'received_at', '2026-05-05T00:00:01.000Z',
      'work_item_external_id', '11111111-1111-1111-1111-111111111111',
    );
  });
});

