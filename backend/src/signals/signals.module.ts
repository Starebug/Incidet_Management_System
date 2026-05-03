import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { StreamProducerService } from './stream-producer.service';

@Module({
  controllers: [SignalsController],
  providers: [SignalsService, StreamProducerService],
  exports: [SignalsService],
})
export class SignalsModule {}

