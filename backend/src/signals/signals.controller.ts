import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { IngestSignalDto } from './dto/ingest-signal.dto';
import { SignalsService } from './signals.service';
import { MetricsService } from '../common/services/metrics.service';

@Controller('signals')
export class SignalsController {
  constructor(
    private readonly signalsService: SignalsService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * POST /api/signals/ingest
   *
   * Accepts a single signal, validates, and enqueues for async processing.
   * Returns 202 Accepted immediately (does not wait for persistence).
   */
  @Post('ingest')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestSignal(@Body() dto: IngestSignalDto) {
    this.metrics.incrementSignalsReceived();

    try {
      const messageId = await this.signalsService.enqueueSignal(dto);
      return {
        statusCode: 202,
        message: 'Signal accepted and queued for processing',
        signal_id: dto.signal_id,
        queue_message_id: messageId,
      };
    } catch (error: any) {
      if (error.message === 'QUEUE_FULL') {
        throw new HttpException(
          {
            statusCode: 503,
            message: 'Service temporarily unavailable. Queue is full.',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }

  /**
   * POST /api/signals/ingest/batch
   *
   * Accepts multiple signals in one request.
   */
  @Post('ingest/batch')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestBatch(@Body() body: { signals: IngestSignalDto[] }) {
    const { signals } = body;

    if (!signals || !Array.isArray(signals) || signals.length === 0) {
      throw new HttpException(
        { statusCode: 400, message: 'signals array is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    this.metrics.incrementSignalsReceived(signals.length);

    const results = await this.signalsService.enqueueBatch(signals);
    return {
      statusCode: 202,
      message: `${results.accepted} signals accepted, ${results.rejected} rejected`,
      accepted: results.accepted,
      rejected: results.rejected,
    };
  }
}


