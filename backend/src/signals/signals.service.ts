import { Injectable } from '@nestjs/common';
import { IngestSignalDto } from './dto/ingest-signal.dto';
import { StreamProducerService } from './stream-producer.service';

@Injectable()
export class SignalsService {
  constructor(private readonly streamProducer: StreamProducerService) {}

  /**
   * Enqueue a single signal into Redis Stream for async processing.
   * Returns Redis message id.
   * Throws 'QUEUE_FULL' if stream is at capacity (backpressure).
   */
  async enqueueSignal(dto: IngestSignalDto): Promise<string> {
    return this.streamProducer.produce(dto);
  }

  /**
   * Enqueue batch of signals. Best-effort: counts accepted vs rejected.
   */
  async enqueueBatch(
    signals: IngestSignalDto[],
  ): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;

    for (const signal of signals) {
      try {
        await this.streamProducer.produce(signal);
        accepted++;
      } catch {
        rejected++;
      }
    }

    return { accepted, rejected };
  }
}


