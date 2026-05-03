import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  public pool: Pool;

  async onModuleInit() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'ims',
      password: process.env.POSTGRES_PASSWORD || 'ims_secret',
      database: process.env.POSTGRES_DB || 'ims_db',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (err: Error) => {
      console.error('[Postgres] Pool error:', err.message);
    });

    // Test connection
    const client = await this.pool.connect();
    console.log('[Postgres] Connected');
    client.release();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}


