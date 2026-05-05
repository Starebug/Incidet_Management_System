import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsString,
  IsUUID,
  IsEnum,
  IsISO8601,
  IsObject,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';

export enum ServiceType {
  API = 'API',
  MCP_HOST = 'MCP_HOST',
  DISTRIBUTED_CACHE = 'DISTRIBUTED_CACHE',
  ASYNC_QUEUE = 'ASYNC_QUEUE',
  RDBMS = 'RDBMS',
  NOSQL = 'NOSQL',
}

export enum SeverityLevel {
  P0 = 'P0',
  P1 = 'P1',
  P2 = 'P2',
  P3 = 'P3',
}

export class IngestSignalDto {
  @IsUUID()
  signal_id!: string;

  @IsString()
  component_id!: string;

  @IsEnum(ServiceType)
  service_type!: ServiceType;

  @IsEnum(SeverityLevel)
  severity!: SeverityLevel;

  @IsISO8601()
  event_ts!: string;

  @IsObject()
  payload!: Record<string, any>;

  @IsOptional()
  @IsString()
  trace_id?: string;
}

export class IngestBatchDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => IngestSignalDto)
  signals!: IngestSignalDto[];
}

