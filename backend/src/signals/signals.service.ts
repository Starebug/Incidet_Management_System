import { Injectable } from '@nestjs/common';
import { IngestSignalDto } from './dto/ingest-signal.dto';
import { StreamProducerService } from './stream-producer.service';

@Injectable()
export class SignalsService {
  private readonly batchEnqueueConcurrency: number;

  constructor(private readonly streamProducer: StreamProducerService) {
    this.batchEnqueueConcurrency = Math.max(
      1,
      parseInt(process.env.BATCH_ENQUEUE_CONCURRENCY || '20', 10),
    );
  }

  /**
   * Enqueue one or more signals with bounded parallelism.
   * Best-effort: counts accepted vs rejected.
   */
  async enqueueBatch(
    signals: IngestSignalDto[],
  ): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;

    for (let i = 0; i < signals.length; i += this.batchEnqueueConcurrency) {
      const chunk = signals.slice(i, i + this.batchEnqueueConcurrency);

      const results = await Promise.allSettled(
        chunk.map((signal) => this.streamProducer.produce(signal)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          accepted++;
        } else {
          rejected++;
        }
      }
    }

    return { accepted, rejected };
  }
}


