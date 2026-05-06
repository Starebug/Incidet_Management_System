import { Module } from '@nestjs/common';
import { SignalStreamConsumer } from './signal-stream.consumer';
import { SignalProcessingModule } from './signal-processing.module';

@Module({
  imports: [SignalProcessingModule],
  providers: [SignalStreamConsumer],
  exports: [SignalStreamConsumer],
})
export class SignalWorkerModule {}

