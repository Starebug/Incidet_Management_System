import { IsISO8601, IsString, MinLength } from 'class-validator';

export class CreateRcaDto {
  @IsISO8601()
  incident_start: string;

  @IsISO8601()
  incident_end: string;

  @IsString()
  @MinLength(1)
  root_cause_category: string;

  @IsString()
  @MinLength(1)
  fix_applied: string;

  @IsString()
  @MinLength(1)
  prevention_steps: string;

  @IsString()
  @MinLength(1)
  created_by: string;
}

