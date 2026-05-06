import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { SignalStreamConsumer } from './signal-stream.consumer';

describe('SignalStreamConsumer', () => {
  const originalWorkerConcurrency = process.env.WORKER_CONCURRENCY;

  afterEach(() => {
    if (originalWorkerConcurrency === undefined) {
      delete process.env.WORKER_CONCURRENCY;
    } else {
      process.env.WORKER_CONCURRENCY = originalWorkerConcurrency;
    }

    jest.clearAllMocks();
  });

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

  function makeConsumer() {
    return new SignalStreamConsumer(
      { stream: {} } as any,
      {} as any,
      {} as any,
    );
  }

  it('uses streaming bounded concurrency so later messages start as soon as a slot frees up', async () => {
    process.env.WORKER_CONCURRENCY = '2';

    const consumer = makeConsumer() as any;
    const started: string[] = [];
    const controls = new Map<string, ReturnType<typeof deferred<void>>>();

    for (const id of ['msg-1', 'msg-2', 'msg-3', 'msg-4']) {
      controls.set(id, deferred<void>());
    }

    consumer.processOne = jest.fn((messageId: string) => {
      started.push(messageId);
      return controls.get(messageId)!.promise;
    });

    const processPromise = consumer.processBatch([
      ['msg-1', []],
      ['msg-2', []],
      ['msg-3', []],
      ['msg-4', []],
    ]);

    await flushAsyncWork();
    expect(started).toEqual(['msg-1', 'msg-2']);

    controls.get('msg-1')!.resolve();
    await flushAsyncWork();
    expect(started).toEqual(['msg-1', 'msg-2', 'msg-3']);

    controls.get('msg-3')!.resolve();
    await flushAsyncWork();
    expect(started).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);

    controls.get('msg-2')!.resolve();
    controls.get('msg-4')!.resolve();

    await expect(processPromise).resolves.toBeUndefined();
  });

  it('falls back to single-message concurrency when WORKER_CONCURRENCY is invalid', async () => {
    process.env.WORKER_CONCURRENCY = '0';

    const consumer = makeConsumer() as any;
    let active = 0;
    let maxActive = 0;

    consumer.processOne = jest.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });

    await consumer.processBatch([
      ['msg-1', []],
      ['msg-2', []],
      ['msg-3', []],
    ]);

    expect(consumer.processOne).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });
});

