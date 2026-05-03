import { Injectable } from '@nestjs/common';

/**
 * Metrics Service
 * Tracks throughput and system health counters.
 * Logs to console every 5 seconds.
 */
@Injectable()
export class MetricsService {
  private signalsReceived = 0;
  private signalsProcessed = 0;
  private rateLimitRejections = 0;
  private dbWriteFailures = 0;
  private intervalRef: NodeJS.Timeout | null = null;

  constructor() {
    // Log metrics every 5 seconds
    this.intervalRef = setInterval(() => {
      this.logMetrics();
    }, 5000);
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
    const perSec = (this.signalsReceived / 5).toFixed(1);

    console.log(JSON.stringify({
      timestamp: now,
      signals_received_5s: this.signalsReceived,
      signals_per_sec: perSec,
      signals_processed_5s: this.signalsProcessed,
      rate_limit_rejections_5s: this.rateLimitRejections,
      db_write_failures_5s: this.dbWriteFailures,
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

