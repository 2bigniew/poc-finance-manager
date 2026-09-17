import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainExceptionFilter } from './filters/domain-exception.filter';

// Shared between main.ts and e2e tests so both bootstrap the exact same global
// pipes/interceptors/filters - see test/health.e2e-spec.ts and test/users.e2e-spec.ts.
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new DomainExceptionFilter());
}
