import { ApiProperty } from '@nestjs/swagger';

export class HealthStatusDto {
  @ApiProperty({ type: String, enum: ['ok'], example: 'ok' })
  status!: 'ok';
}

export class ReadinessStatusDto {
  @ApiProperty({ type: String, enum: ['ok'], example: 'ok' })
  status!: 'ok';

  @ApiProperty({ type: String, enum: ['ok'], example: 'ok' })
  postgres!: 'ok';
}

// Body of the 503 readiness failure (ServiceUnavailableException with this object).
export class ReadinessFailureDto {
  @ApiProperty({ type: String, enum: ['error'], example: 'error' })
  status!: 'error';

  @ApiProperty({ type: String, enum: ['unavailable'], example: 'unavailable' })
  postgres!: 'unavailable';
}
