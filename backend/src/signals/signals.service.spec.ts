import { SignalsService } from './signals.service';
import { IngestSignalDto, ServiceType, SeverityLevel } from './dto/ingest-signal.dto';

describe('SignalsService', () => {
  const originalConcurrency = process.env.BATCH_ENQUEUE_CONCURRENCY;

  afterEach(() => {
    if (originalConcurrency === undefined) {
      delete process.env.BATCH_ENQUEUE_CONCURRENCY;
    } else {
      process.env.BATCH_ENQUEUE_CONCURRENCY = originalConcurrency;
    }

    jest.clearAllMocks();
  });

  function makeSignal(id: string): IngestSignalDto {
    return {
      signal_id: id,
      component_id: 'COMPONENT_A',
      service_type: ServiceType.API,
      severity: SeverityLevel.P1,
      event_ts: '2026-05-05T00:00:00.000Z',
      payload: { ok: true },
      trace_id: `trace-${id}`,
    };
  }

  it('enqueues batch items with bounded parallelism and preserves accepted/rejected counts', async () => {
    process.env.BATCH_ENQUEUE_CONCURRENCY = '2';

    let active = 0;
    let maxActive = 0;

    const streamProducer = {
      produce: jest.fn(async (signal: IngestSignalDto) => {
        active++;
        maxActive = Math.max(maxActive, active);

        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;

        if (signal.signal_id === 'sig-3') {
          throw new Error('QUEUE_FULL');
        }

        return `msg-${signal.signal_id}`;
      }),
    };

    const service = new SignalsService(streamProducer as any);

    const result = await service.enqueueBatch([
      makeSignal('sig-1'),
      makeSignal('sig-2'),
      makeSignal('sig-3'),
      makeSignal('sig-4'),
      makeSignal('sig-5'),
    ]);

    expect(result).toEqual({ accepted: 4, rejected: 1 });
    expect(streamProducer.produce).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(2);
  });

  it('falls back to single-item chunks when concurrency is invalid', async () => {
    process.env.BATCH_ENQUEUE_CONCURRENCY = '0';

    const streamProducer = {
      produce: jest.fn(async (signal: IngestSignalDto) => `msg-${signal.signal_id}`),
    };

    const service = new SignalsService(streamProducer as any);
    const result = await service.enqueueBatch([makeSignal('sig-1'), makeSignal('sig-2')]);

    expect(result).toEqual({ accepted: 2, rejected: 0 });
    expect(streamProducer.produce).toHaveBeenCalledTimes(2);
  });
});

