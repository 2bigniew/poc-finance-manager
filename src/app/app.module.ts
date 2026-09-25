import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from '@config/app.config';
import authConfig from '@config/auth.config';
import dbConfig from '@config/db.config';
import httpConfig from '@config/http.config';
import kafkaConfig from '@config/kafka.config';
import outboxConfig from '@config/outbox.config';
import { AuthModule } from './modules/auth/auth.module';
import { BrokerKafkaModule } from './modules/broker-kafka/broker-kafka.module';
import { DatabaseModule } from './modules/database/database.module';
import { InvoicesModule } from './modules/domain/invoices/invoices.module';
import { ProgramsModule } from './modules/domain/programs/programs.module';
import { ReconciliationsModule } from './modules/domain/reconciliations/reconciliations.module';
import { ReleasesModule } from './modules/domain/releases/releases.module';
import { ReservationsModule } from './modules/domain/reservations/reservations.module';
import { UsersModule } from './modules/domain/users/users.module';
import { HealthModule } from './modules/health/health.module';
import { HttpModule } from './modules/http/http.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [
        appConfig,
        dbConfig,
        kafkaConfig,
        authConfig,
        httpConfig,
        outboxConfig,
      ],
    }),
    DatabaseModule,
    BrokerKafkaModule.forRootAsync(),
    HttpModule,
    HealthModule,
    UsersModule,
    AuthModule,
    ProgramsModule,
    InvoicesModule,
    ReservationsModule,
    ReleasesModule,
    ReconciliationsModule,
  ],
})
export class AppModule {}
