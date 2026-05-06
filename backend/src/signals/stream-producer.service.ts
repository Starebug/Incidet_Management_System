import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { IngestSignalDto } from './dto/ingest-signal.dto';

/**
 * StreamProducerService
 *
 * Produces messages into Redis Stream for async worker consumption.
 *
 * Backpressure strategy: Atomic Lua admission control
 * - Single Redis round trip (vs previous 2-trip XLEN + XADD)
 * - Atomically checks queue depth AND enqueues in one script
 * - No race condition: two concurrent producers cannot both bypass the limit
 * - Returns QUEUE_FULL if stream is at capacity → API returns 503
 * - MAXLEN ~ still included as a secondary safety trim guard
 *
 * Why Lua over separate XLEN + XADD:
 * - XLEN → XADD is not atomic: concurrent producers can both see length < max
 *   and both enqueue, exceeding the bounded limit
 * - Lua script executes atomically in Redis: no interleaving possible
 */
@Injectable()
export class StreamProducerService {
  private readonly streamKey: string;
  private readonly maxLength: number;

  /**
   * Lua script: atomic bounded enqueue
   *
   * KEYS[1] = stream key
   * ARGV[1] = max length
   * ARGV[2..N] = field/value pairs for XADD
   *
   * Returns:
   *   - message id (string) on success
   *   - "QUEUE_FULL" if stream at capacity
   */
  private readonly ATOMIC_ENQUEUE_SCRIPT = `
    local stream_key = KEYS[1]
    local max_length = tonumber(ARGV[1])

    -- Atomically check current stream length
    local current_length = redis.call('XLEN', stream_key)

    if current_length >= max_length then
      return "QUEUE_FULL"
    end

    -- Build XADD args: stream_key, MAXLEN, ~, max_length, *, field1, val1, ...
    local xadd_args = {stream_key, 'MAXLEN', '~', tostring(max_length), '*'}
    for i = 2, #ARGV do
      table.insert(xadd_args, ARGV[i])
    end

    -- Atomically enqueue
    local message_id = redis.call('XADD', unpack(xadd_args))
    return message_id
  `;

  constructor(private readonly redis: RedisService) {
    this.streamKey = process.env.STREAM_KEY || 'signals:ingest';
    this.maxLength = parseInt(process.env.STREAM_MAX_LENGTH || '100000', 10);
  }

  /**
   * Atomically check queue depth and enqueue signal in one Redis round trip.
   * Throws 'QUEUE_FULL' if stream is at capacity.
   */
  async produce(signal: IngestSignalDto): Promise<string> {
    const fieldValues = [
      'signal_id',    signal.signal_id,
      'component_id', signal.component_id,
      'service_type', signal.service_type,
      'severity',     signal.severity,
      'event_ts',     signal.event_ts,
      'payload',      JSON.stringify(signal.payload),
      'trace_id',     signal.trace_id || '',
      'received_at',  new Date().toISOString(),
    ];

    const result = await this.redis.queue.eval(
      this.ATOMIC_ENQUEUE_SCRIPT,
      1,                        // number of KEYS
      this.streamKey,           // KEYS[1]
      String(this.maxLength),   // ARGV[1] = max_length
      ...fieldValues,           // ARGV[2..N] = field/value pairs
    ) as string;

    if (result === 'QUEUE_FULL') {
      throw new Error('QUEUE_FULL');
    }

    return result; // Redis stream message id e.g. "1714550400000-0"
  }

}
