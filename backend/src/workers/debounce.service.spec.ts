/// <reference types="jest" />

import {
  DebounceResolutionInProgressError,
  DebounceService,
} from './debounce.service';

describe('DebounceService', () => {
  const originalLockTtl = process.env.DEBOUNCE_CREATION_LOCK_TTL_SEC;
  const originalDebounceTtl = process.env.DEBOUNCE_TTL_SEC;

  afterEach(() => {
    if (originalLockTtl === undefined) {
      delete process.env.DEBOUNCE_CREATION_LOCK_TTL_SEC;
    } else {
      process.env.DEBOUNCE_CREATION_LOCK_TTL_SEC = originalLockTtl;
    }

    if (originalDebounceTtl === undefined) {
      delete process.env.DEBOUNCE_TTL_SEC;
    } else {
      process.env.DEBOUNCE_TTL_SEC = originalDebounceTtl;
    }

    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function makeService() {
    const redis = {
      client: {
        eval: jest.fn(),
        set: jest.fn(),
      },
    };

    const workItem = {
      findActiveByComponent: jest.fn(),
    };

    const service = new DebounceService(redis as any, workItem as any);
    return { service, redis, workItem };
  }

  it('reuses an existing debounce key returned by the atomic Lua check', async () => {
    const { service } = makeService();

    jest.spyOn(service as any, 'atomicGetOrAcquire').mockResolvedValue({
      disposition: 'EXISTING',
      existingId: 'incident-1',
    });

    const result = await service.resolveWorkItem(
      'COMPONENT_A',
      'API',
      'P1',
      new Date('2026-05-05T00:00:00.000Z'),
    );

    expect(result).toEqual({
      workItemExternalId: 'incident-1',
      isNew: false,
    });
  });

  it('returns a new work item id only for the worker that atomically acquires the creator lock', async () => {
    const { service, workItem } = makeService();

    jest.spyOn(service as any, 'atomicGetOrAcquire').mockResolvedValue({
      disposition: 'ACQUIRED',
    });
    workItem.findActiveByComponent.mockResolvedValue(null);

    const result = await service.resolveWorkItem(
      'COMPONENT_A',
      'API',
      'P1',
      new Date('2026-05-05T00:00:00.000Z'),
    );

    expect(result.isNew).toBe(true);
    expect(result.workItemExternalId).toBeTruthy();
    expect(result.creationToken).toBeTruthy();
  });

  it('throws a retriable in-progress error instead of creating anyway when another worker still owns creation', async () => {
    const { service, workItem } = makeService();

    jest.spyOn(service as any, 'atomicGetOrAcquire').mockResolvedValue({
      disposition: 'WAIT',
    });
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    workItem.findActiveByComponent.mockResolvedValue(null);

    await expect(
      service.resolveWorkItem(
        'COMPONENT_A',
        'API',
        'P1',
        new Date('2026-05-05T00:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(DebounceResolutionInProgressError);
  });

  it('publishes the debounce key only after successful work item creation finalization', async () => {
    const { service, redis } = makeService();

    await service.finalizeNewWorkItem('COMPONENT_A', 'incident-1', 'token-1');

    expect(redis.client.eval).toHaveBeenCalled();
  });
});


