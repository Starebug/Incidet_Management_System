export type AppRole = 'all' | 'api' | 'signal-worker' | 'audit-worker';

const VALID_APP_ROLES = new Set<AppRole>([
  'all',
  'api',
  'signal-worker',
  'audit-worker',
]);

export function getAppRole(value = process.env.APP_ROLE): AppRole {
  const normalized = value?.trim().toLowerCase();
  if (normalized && VALID_APP_ROLES.has(normalized as AppRole)) {
    return normalized as AppRole;
  }

  return 'all';
}

export function isHttpRole(role = getAppRole()): boolean {
  return role === 'all' || role === 'api';
}

export function runsSignalWorker(role = getAppRole()): boolean {
  return role === 'all' || role === 'signal-worker';
}

export function runsAuditWorker(role = getAppRole()): boolean {
  return role === 'all' || role === 'audit-worker';
}

