import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from '@config/app.config';
import authConfig from '@config/auth.config';
import dbConfig from '@config/db.config';
import httpConfig from '@config/http.config';
import kafkaConfig from '@config/kafka.config';
import { BrokerKafkaModule } from './modules/broker-kafka/broker-kafka.module';
import { DatabaseModule } from './modules/database/database.module';
import { HealthModule } from './modules/health/health.module';
import { HttpModule } from './modules/http/http.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [appConfig, dbConfig, kafkaConfig, authConfig, httpConfig],
    }),
    DatabaseModule,
    BrokerKafkaModule.forRootAsync(),
    HttpModule,
    HealthModule,
  ],
})
export class AppModule {}
