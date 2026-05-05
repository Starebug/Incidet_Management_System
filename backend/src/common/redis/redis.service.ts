import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly commandClient: Redis;
  private readonly streamClient: Redis;
  private readonly auditStreamClient: Redis;

  constructor() {
    this.commandClient = this.createClient('command');
    this.streamClient = this.createClient('stream');
    this.auditStreamClient = this.createClient('audit-stream');
  }

  /**
   * Facade accessor for the default non-blocking Redis connection.
   * Existing callers continue to use `redis.client` unchanged.
   */
  get client(): Redis {
    return this.commandClient;
  }

  /**
   * Dedicated Redis connection for blocking stream-consumer commands.
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

  async onModuleInit() {
    // Eager initialization is done in the constructor so dependent providers
    // can safely use `client` inside their own `onModuleInit()` hooks.
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.commandClient?.quit(),
      this.streamClient?.quit(),
      this.auditStreamClient?.quit(),
    ]);
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.commandClient.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  private createClient(role: 'command' | 'stream' | 'audit-stream'): Redis {
    const client = new Redis(this.buildOptions());

    client.on('error', (err) => {
      console.error(`[Redis:${role}] Connection error:`, err.message);
    });

    client.on('connect', () => {
      console.log(`[Redis:${role}] Connected`);
    });

    return client;
  }

  private buildOptions(): RedisOptions {
    return {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      },
    };
  }
}

