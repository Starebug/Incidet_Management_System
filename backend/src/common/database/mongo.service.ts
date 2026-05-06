import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MongoClient, Db, Collection, ReadPreference } from 'mongodb';

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private client!: MongoClient;
  private db!: Db;

  async onModuleInit() {
    const uri = process.env.MONGODB_URI || 'mongodb://ims:ims_secret@localhost:27017/ims?authSource=admin';

    this.client = new MongoClient(uri, {
      maxPoolSize: 50,
      minPoolSize: 5,
      maxIdleTimeMS: 30000,
    });

    await this.client.connect();
    this.db = this.client.db('ims');
    console.log('[MongoDB] Connected');
  }

  async onModuleDestroy() {
    await this.client.close();
  }


  get signalsRaw(): Collection {
    return this.db.collection('signals_raw');
  }

  /**
   * Secondary-preferred accessor for audit/history browsing.
   *
   * Pattern C: latest audit logs may be briefly delayed, so read operations
   * can prefer replicas when a replica set is available. In local standalone
   * MongoDB setups, `secondaryPreferred` safely falls back to primary.
   */
  get signalsRawReplicaRead(): Collection {
    return this.db.collection('signals_raw', {
      readPreference: ReadPreference.secondaryPreferred,
    });
  }

  get deadLetterQueue(): Collection {
    return this.db.collection('dead_letter_queue');
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }
}

