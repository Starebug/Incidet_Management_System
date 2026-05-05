import { Injectable } from '@nestjs/common';

/**
 * Metrics Service
 * Tracks throughput and system health counters.
 * Logs to console every 20 seconds.
 */
@Injectable()
export class MetricsService {
  private signalsReceived = 0;
  private signalsProcessed = 0;
  private rateLimitRejections = 0;
  private dbWriteFailures = 0;
  private intervalRef: NodeJS.Timeout | null = null;

  constructor() {
    // Log metrics every 20 seconds
    this.intervalRef = setInterval(() => {
      this.logMetrics();
    }, 20000);
  }

  incrementSignalsReceived(count = 1): void {
    this.signalsReceived += count;
  }

  incrementSignalsProcessed(count = 1): void {
    this.signalsProcessed += count;
  }

  incrementRateLimitRejections(count = 1): void {
    this.rateLimitRejections += count;
  }

  incrementDbWriteFailures(count = 1): void {
    this.dbWriteFailures += count;
  }

  private logMetrics(): void {
    const now = new Date().toISOString();
    const perSec = (this.signalsReceived / 20).toFixed(1);

    console.log(JSON.stringify({
      timestamp: now,
      signals_received_20s: this.signalsReceived,
      signals_per_sec: perSec,
      signals_processed_20s: this.signalsProcessed,
      rate_limit_rejections_20s: this.rateLimitRejections,
      db_write_failures_20s: this.dbWriteFailures,
    }));

    // Reset counters
    this.signalsReceived = 0;
    this.signalsProcessed = 0;
    this.rateLimitRejections = 0;
    this.dbWriteFailures = 0;
  }

  onModuleDestroy(): void {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
    }
  }
}

