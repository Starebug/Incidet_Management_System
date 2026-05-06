import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly controlClient: Redis;
  private readonly queueClient: Redis;
  private readonly streamClient: Redis;
  private readonly auditStreamClient: Redis;
  private readonly dashboardClient: Redis;

  constructor() {
    this.controlClient = this.createClient('control');
    this.queueClient = this.createClient('queue');
    this.streamClient = this.createClient('stream');
    this.auditStreamClient = this.createClient('audit-stream');
    this.dashboardClient = this.createClient('dashboard');
  }

  /**
   * Facade accessor for the rate-limit / debounce Redis instance.
   */
  get control(): Redis {
    return this.controlClient;
  }

  /**
   * Non-blocking command connection for the streams Redis instance.
   * Used by producers / XADD-based scheduling paths.
   */
  get queue(): Redis {
    return this.queueClient;
  }

  /**
   * Dedicated Redis connection for blocking ingest-stream consumer commands.
   */
  get stream(): Redis {
    return this.streamClient;
  }

  /**
   * Dedicated Redis connection for the audit persistence worker stream.
   * This avoids contending two independent BLOCK readers on one socket.
   */
  get auditStream(): Redis {
    return this.auditStreamClient;
  }

  /**
   * Dedicated Redis connection for dashboard/cache reads and writes.
   */
  get dashboard(): Redis {
    return this.dashboardClient;
  }

  async onModuleInit() {
    // Eager initialization is done in the constructor so dependent providers
    // can safely use redis accessors inside their own `onModuleInit()` hooks.
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.controlClient?.quit(),
      this.queueClient?.quit(),
      this.streamClient?.quit(),
      this.auditStreamClient?.quit(),
      this.dashboardClient?.quit(),
    ]);
  }

  async ping(): Promise<boolean> {
    const results = await Promise.allSettled([
      this.controlClient.ping(),
      this.queueClient.ping(),
      this.dashboardClient.ping(),
    ]);

    return results.every(
      (result) => result.status === 'fulfilled' && result.value === 'PONG',
    );
  }

  private createClient(role: 'control' | 'queue' | 'stream' | 'audit-stream' | 'dashboard'): Redis {
    const client = new Redis(this.buildOptions(role));

    client.on('error', (err) => {
      console.error(`[Redis:${role}] Connection error:`, err.message);
    });

    client.on('connect', () => {
      console.log(`[Redis:${role}] Connected`);
    });

    return client;
  }

  private buildOptions(role: 'control' | 'queue' | 'stream' | 'audit-stream' | 'dashboard'): RedisOptions {
    const { host, port } = this.resolveEndpoint(role);

    return {
      host,
      port,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    };
  }

  private resolveEndpoint(
    role: 'control' | 'queue' | 'stream' | 'audit-stream' | 'dashboard',
  ): { host: string; port: number } {
    const fallbackHost = process.env.REDIS_HOST || 'localhost';
    const fallbackPort = parseInt(process.env.REDIS_PORT || '6379', 10);

    if (role === 'control') {
      return {
        host: process.env.REDIS_CONTROL_HOST || fallbackHost,
        port: parseInt(process.env.REDIS_CONTROL_PORT || String(fallbackPort), 10),
      };
    }

    if (role === 'dashboard') {
      return {
        host: process.env.REDIS_DASHBOARD_HOST || fallbackHost,
        port: parseInt(process.env.REDIS_DASHBOARD_PORT || String(fallbackPort), 10),
      };
    }

    return {
      host: process.env.REDIS_STREAMS_HOST || fallbackHost,
      port: parseInt(process.env.REDIS_STREAMS_PORT || String(fallbackPort), 10),
    };
  }
}

