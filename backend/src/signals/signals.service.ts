import { Injectable } from '@nestjs/common';
import { IngestSignalDto } from './dto/ingest-signal.dto';
import { StreamProducerService } from './stream-producer.service';

@Injectable()
export class SignalsService {
  private readonly batchEnqueueConcurrency: number;
  private readonly batchChunkSize: number;

  constructor(private readonly streamProducer: StreamProducerService) {
    this.batchEnqueueConcurrency = Math.max(
      1,
      parseInt(process.env.BATCH_ENQUEUE_CONCURRENCY || '20', 10),
    );
    this.batchChunkSize = Math.max(
      this.batchEnqueueConcurrency,
      parseInt(process.env.BATCH_ENQUEUE_CHUNK_SIZE || '250', 10),
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

    for (let i = 0; i < signals.length; i += this.batchChunkSize) {
      const requestChunk = signals.slice(i, i + this.batchChunkSize);

      const inFlight = new Set<Promise<void>>();

      for (const signal of requestChunk) {
        const task = this.streamProducer.produce(signal)
          .then(() => {
            accepted++;
          })
          .catch(() => {
            rejected++;
          })
          .finally(() => {
            inFlight.delete(task);
          });

        inFlight.add(task);

        if (inFlight.size >= this.batchEnqueueConcurrency) {
          await Promise.race(inFlight);
        }
      }

      await Promise.allSettled(inFlight);
    }

    return { accepted, rejected };
  }
}


