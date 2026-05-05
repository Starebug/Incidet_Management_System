import {
  ActiveAuditProcessingLeaseError,
  AuditDlqHandledError,
  AuditPersistenceProcessor,
} from './audit-persistence.processor';

describe('AuditPersistenceProcessor', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.AUDIT_MAX_ATTEMPTS;
  });

  it('persists the raw signal and marks the audit ledger as persisted', async () => {
    process.env.AUDIT_MAX_ATTEMPTS = '5';

    const auditLedger = {
      beginProcessing: jest.fn().mockResolvedValue({
        disposition: 'PROCESS',
        attemptCount: 1,
        workItemExternalId: 'work-item-1',
      }),
      markPersisted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      markDeadLettered: jest.fn().mockResolvedValue(undefined),
    };

    const signalRepo = {
      upsertRawSignal: jest.fn().mockResolvedValue(undefined),
    };

    const dlq = {
      send: jest.fn().mockResolvedValue(true),
    };

    const processor = new AuditPersistenceProcessor(
      auditLedger as any,
      signalRepo as any,
      dlq as any,
    );

    await processor.process({
      signal_id: 'sig-1',
      component_id: 'COMPONENT_A',
      service_type: 'API',
      severity: 'P1',
      event_ts: '2026-05-05T00:00:00.000Z',
      payload: JSON.stringify({ ok: true }),
      trace_id: 'trace-1',
      received_at: '2026-05-05T00:00:01.000Z',
      work_item_external_id: 'work-item-1',
    });

    expect(signalRepo.upsertRawSignal).toHaveBeenCalledWith(expect.objectContaining({
      signal_id: 'sig-1',
      linked_work_item_id: 'work-item-1',
      payload: { ok: true },
    }));
    expect(auditLedger.markPersisted).toHaveBeenCalledWith('sig-1');
    expect(auditLedger.markFailed).not.toHaveBeenCalled();
  });

  it('surfaces a fresh lease as a non-ack retry signal', async () => {
    const auditLedger = {
      beginProcessing: jest.fn().mockResolvedValue({
        disposition: 'LEASE_HELD',
        attemptCount: 2,
        leaseAgeMs: 1000,
      }),
    };

    const processor = new AuditPersistenceProcessor(
      auditLedger as any,
      { upsertRawSignal: jest.fn() } as any,
      { send: jest.fn() } as any,
    );

    await expect(processor.process({ signal_id: 'sig-lease' } as any)).rejects.toBeInstanceOf(
      ActiveAuditProcessingLeaseError,
    );
  });

  it('moves terminally failing audit work to the DLQ after the max attempt threshold', async () => {
    process.env.AUDIT_MAX_ATTEMPTS = '2';

    const auditLedger = {
      beginProcessing: jest.fn().mockResolvedValue({
        disposition: 'PROCESS',
        attemptCount: 3,
        workItemExternalId: 'work-item-1',
      }),
      markDeadLettered: jest.fn().mockResolvedValue(undefined),
    };

    const dlq = {
      send: jest.fn().mockResolvedValue(true),
    };

    const processor = new AuditPersistenceProcessor(
      auditLedger as any,
      { upsertRawSignal: jest.fn() } as any,
      dlq as any,
    );

    await expect(
      processor.process({ signal_id: 'sig-dlq', work_item_external_id: 'work-item-1' } as any),
    ).rejects.toBeInstanceOf(AuditDlqHandledError);

    expect(dlq.send).toHaveBeenCalledWith(
      expect.objectContaining({ signal_id: 'sig-dlq' }),
      'AUDIT_PERSISTENCE_MAX_ATTEMPTS_EXCEEDED',
      'Exceeded max audit persistence attempts (2)',
      3,
    );
    expect(auditLedger.markDeadLettered).toHaveBeenCalledWith(
      'sig-dlq',
      'Exceeded max audit persistence attempts (2)',
    );
  });
});

