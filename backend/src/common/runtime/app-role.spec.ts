import { afterEach, describe, expect, it } from '@jest/globals';
import { getAppRole, isHttpRole, runsAuditWorker, runsSignalWorker } from './app-role';
describe('app-role helpers', () => {
  const originalRole = process.env.APP_ROLE;
  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalRole;
    }
  });
  it('defaults to all when APP_ROLE is absent or invalid', () => {
    delete process.env.APP_ROLE;
    expect(getAppRole()).toBe('all');
    process.env.APP_ROLE = 'unknown-role';
    expect(getAppRole()).toBe('all');
  });
  it('recognizes api and worker roles', () => {
    process.env.APP_ROLE = 'api';
    expect(getAppRole()).toBe('api');
    expect(isHttpRole()).toBe(true);
    expect(runsSignalWorker()).toBe(false);
    expect(runsAuditWorker()).toBe(false);
    process.env.APP_ROLE = 'signal-worker';
    expect(isHttpRole()).toBe(false);
    expect(runsSignalWorker()).toBe(true);
    expect(runsAuditWorker()).toBe(false);
    process.env.APP_ROLE = 'audit-worker';
    expect(isHttpRole()).toBe(false);
    expect(runsSignalWorker()).toBe(false);
    expect(runsAuditWorker()).toBe(true);
  });
});
