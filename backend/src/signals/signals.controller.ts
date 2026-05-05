import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { IngestBatchDto } from './dto/ingest-signal.dto';
import { SignalsService } from './signals.service';
import { MetricsService } from '../common/services/metrics.service';

@Controller('signals')
export class SignalsController {
  constructor(
    private readonly signalsService: SignalsService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * POST /api/signals/ingest/batch
   *
   * Accepts one or more signals in one request.
   * Nested DTO validation ensures every signal_id/service_type/etc. is validated
   * before the batch reaches the ingestion pipeline.
   */
  @Post('ingest/batch')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestBatch(@Body() body: IngestBatchDto) {
    const { signals } = body;


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


