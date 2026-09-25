import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '@app/modules/auth/decorators/public.decorator';
import {
  HealthStatusDto,
  ReadinessFailureDto,
  ReadinessStatusDto,
} from './dto/health-status.dto';
import { HealthService } from './health.service';

@ApiTags('Health')
@Public()
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'getHealth',
    summary: 'Liveness check',
    description:
      'Reports that the process is up and serving HTTP. Checks no dependencies. Public.',
  })
  @ApiOkResponse({ type: HealthStatusDto })
  checkHealth(): HealthStatusDto {
    return { status: 'ok' };
  }

  @Get('readiness')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'getReadiness',
    summary: 'Readiness check (PostgreSQL)',
    description:
      'Runs `select 1` against PostgreSQL. Kafka is not part of this check. Public.',
  })
  @ApiOkResponse({ type: ReadinessStatusDto })
  @ApiServiceUnavailableResponse({
    type: ReadinessFailureDto,
    description: 'PostgreSQL is unreachable.',
  })
  async checkReadiness(): Promise<ReadinessStatusDto> {
    const isPostgresReady = await this.healthService.isPostgresReady();
    if (!isPostgresReady) {
      throw new ServiceUnavailableException({
        status: 'error',
        postgres: 'unavailable',
      });
    }

    return { status: 'ok', postgres: 'ok' };
  }
}
