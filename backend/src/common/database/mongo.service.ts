import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { MongoClient, Db, Collection } from 'mongodb';

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private client: MongoClient;
  private db: Db;

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

  getCollection(name: string): Collection {
    return this.db.collection(name);
  }

  get signalsRaw(): Collection {
    return this.db.collection('signals_raw');
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

