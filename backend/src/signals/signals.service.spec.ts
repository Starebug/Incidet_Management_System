import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { SignalsService } from './signals.service';
import { IngestSignalDto, ServiceType, SeverityLevel } from './dto/ingest-signal.dto';

describe('SignalsService', () => {
  const originalConcurrency = process.env.BATCH_ENQUEUE_CONCURRENCY;
  const originalChunkSize = process.env.BATCH_ENQUEUE_CHUNK_SIZE;

  afterEach(() => {
    if (originalConcurrency === undefined) {
      delete process.env.BATCH_ENQUEUE_CONCURRENCY;
    } else {
      process.env.BATCH_ENQUEUE_CONCURRENCY = originalConcurrency;
    }

    if (originalChunkSize === undefined) {
      delete process.env.BATCH_ENQUEUE_CHUNK_SIZE;
    } else {
      process.env.BATCH_ENQUEUE_CHUNK_SIZE = originalChunkSize;
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

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function flushAsyncWork() {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('splits large requests into bounded internal chunks before applying enqueue concurrency', async () => {
    process.env.BATCH_ENQUEUE_CONCURRENCY = '2';
    process.env.BATCH_ENQUEUE_CHUNK_SIZE = '3';

    const startOrder: string[] = [];
    let active = 0;
    let maxActive = 0;

    const streamProducer = {
      produce: jest.fn(async (signal: IngestSignalDto) => {
        startOrder.push(signal.signal_id);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
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
      makeSignal('sig-6'),
      makeSignal('sig-7'),
    ]);

    expect(result).toEqual({ accepted: 7, rejected: 0 });
    expect(streamProducer.produce).toHaveBeenCalledTimes(7);
    expect(maxActive).toBe(2);
    expect(startOrder).toEqual([
      'sig-1', 'sig-2',
      'sig-3',
      'sig-4', 'sig-5',
      'sig-6',
      'sig-7',
    ]);
  });

  it('uses streaming bounded parallelism within each internal chunk instead of waiting for whole sub-batches', async () => {
    process.env.BATCH_ENQUEUE_CONCURRENCY = '2';
    process.env.BATCH_ENQUEUE_CHUNK_SIZE = '4';

    const started: string[] = [];
    const controls = new Map<string, ReturnType<typeof deferred<string>>>();

    for (const id of ['sig-1', 'sig-2', 'sig-3', 'sig-4']) {
      controls.set(id, deferred<string>());
    }

    const streamProducer = {
      produce: jest.fn((signal: IngestSignalDto) => {
        started.push(signal.signal_id);
        return controls.get(signal.signal_id)!.promise;
      }),
    };

    const service = new SignalsService(streamProducer as any);
    const enqueuePromise = service.enqueueBatch([
      makeSignal('sig-1'),
      makeSignal('sig-2'),
      makeSignal('sig-3'),
      makeSignal('sig-4'),
    ]);

    await flushAsyncWork();
    expect(started).toEqual(['sig-1', 'sig-2']);

    controls.get('sig-1')!.resolve('msg-sig-1');
    await flushAsyncWork();
    expect(started).toEqual(['sig-1', 'sig-2', 'sig-3']);

    controls.get('sig-3')!.resolve('msg-sig-3');
    await flushAsyncWork();
    expect(started).toEqual(['sig-1', 'sig-2', 'sig-3', 'sig-4']);

    controls.get('sig-2')!.resolve('msg-sig-2');
    controls.get('sig-4')!.resolve('msg-sig-4');

    await expect(enqueuePromise).resolves.toEqual({ accepted: 4, rejected: 0 });
  });
});

