import { AlertStrategy, SignalContext } from './alert-strategy.interface';

// ─── RDBMS: Always Critical (P0) ──────────────────────────────────
export class RdbmsAlertStrategy implements AlertStrategy {
  determineSeverity(_signal: SignalContext): string {
    return 'P0'; // Database failures are always critical
  }

  getNotificationChannels(): string[] {
    return ['pagerduty', 'slack-critical', 'email-oncall'];
  }

  shouldPage(): boolean {
    return true;
  }
}

// ─── API: High (P1) ───────────────────────────────────────────────
export class ApiAlertStrategy implements AlertStrategy {
  determineSeverity(signal: SignalContext): string {
    // Timeout = P1, other errors = P2
    if (signal.payload.error_code === 'UPSTREAM_TIMEOUT') {
      return 'P1';
    }
    return 'P2';
  }

  getNotificationChannels(): string[] {
    return ['slack-infra', 'email-team'];
  }

  shouldPage(): boolean {
    return false;
  }
}

// ─── MCP Host: High (P1) ──────────────────────────────────────────
export class McpHostAlertStrategy implements AlertStrategy {
  determineSeverity(_signal: SignalContext): string {
    return 'P1';
  }

  getNotificationChannels(): string[] {
    return ['slack-infra', 'email-oncall'];
  }

  shouldPage(): boolean {
    return true;
  }
}

// ─── Distributed Cache: Medium (P2) ───────────────────────────────
export class CacheAlertStrategy implements AlertStrategy {
  determineSeverity(signal: SignalContext): string {
    // High miss rate escalates to P1
    const missRate = signal.payload.miss_rate_percent || signal.payload.missRate;
    if (missRate && missRate > 50) {
      return 'P1';
    }
    return 'P2';
  }

  getNotificationChannels(): string[] {
    return ['slack-infra', 'email-team'];
  }

  shouldPage(): boolean {
    return false;
  }
}

// ─── Async Queue: Medium (P2) ─────────────────────────────────────
export class QueueAlertStrategy implements AlertStrategy {
  determineSeverity(signal: SignalContext): string {
    const lag = signal.payload.current_lag;
    if (lag && lag > 100000) {
      return 'P1'; // Extreme lag
    }
    return 'P2';
  }

  getNotificationChannels(): string[] {
    return ['slack-infra'];
  }

  shouldPage(): boolean {
    return false;
  }
}

// ─── NoSQL: Medium (P2) ───────────────────────────────────────────
export class NoSqlAlertStrategy implements AlertStrategy {
  determineSeverity(_signal: SignalContext): string {
    return 'P2';
  }

  getNotificationChannels(): string[] {
    return ['slack-infra'];
  }

  shouldPage(): boolean {
    return false;
  }
}

// ─── Default: Low (P3) ────────────────────────────────────────────
export class DefaultAlertStrategy implements AlertStrategy {
  determineSeverity(signal: SignalContext): string {
    // Fall back to the severity the producer sent, or P3
    return signal.rawSeverity || 'P3';
  }

  getNotificationChannels(): string[] {
    return ['slack-monitoring'];
  }

  shouldPage(): boolean {
    return false;
  }
}

