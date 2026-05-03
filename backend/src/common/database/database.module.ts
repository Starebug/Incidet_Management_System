import { Module, Global } from '@nestjs/common';
import { PostgresService } from './postgres.service';
import { MongoService } from './mongo.service';

@Global()
@Module({
  providers: [PostgresService, MongoService],
  exports: [PostgresService, MongoService],
})
export class DatabaseModule {}

