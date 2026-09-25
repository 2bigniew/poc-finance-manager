import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppConfig } from '@config/app.config';
import { AppModule } from './app/app.module';
import { configureApp } from './app/configure-app';
import { configureSwagger } from './app/configure-swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);
  configureSwagger(app);

  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>('app');

  await app.listen(appConfig.port);

  Logger.log(`Application listening on port ${appConfig.port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  Logger.error(
    'Application failed to start',
    error instanceof Error ? error.stack : undefined,
    'Bootstrap',
  );
  // `process.exitCode = 1` alone does not terminate the process - it only takes effect
  // once the event loop drains naturally, which open Kafka/PostgreSQL handles can
  // prevent indefinitely. A bootstrap failure must hard-exit so Docker's restart policy
  // (or any other orchestrator) can actually detect and recover from it.
  process.exit(1);
});
