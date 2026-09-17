import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '@app/modules/auth/decorators/public.decorator';
import { HealthService } from './health.service';

interface HealthStatus {
  status: 'ok';
}

interface ReadinessStatus {
  status: 'ok';
  postgres: 'ok';
}

@Public()
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  checkHealth(): HealthStatus {
    return { status: 'ok' };
  }

  @Get('readiness')
  @HttpCode(HttpStatus.OK)
  async checkReadiness(): Promise<ReadinessStatus> {
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
