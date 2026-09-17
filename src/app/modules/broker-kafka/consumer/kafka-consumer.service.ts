import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { KafkaConsumerDiscoveryService } from './kafka-consumer-discovery.service';
import { KafkaConsumerRunnerService } from './kafka-consumer-runner.service';

// NestJS lifecycle owner for Kafka consumption: discovers decorated handlers once every
// module has finished initializing, starts one consumer per handler, and disconnects
// them on shutdown. Discovery/execution mechanics live in
// KafkaConsumerDiscoveryService/KafkaConsumerRunnerService - this class only wires
// lifecycle to them (CLAUDE.md section 25).
@Injectable()
export class KafkaConsumerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(KafkaConsumerService.name);

  constructor(
    private readonly discoveryService: KafkaConsumerDiscoveryService,
    private readonly runnerService: KafkaConsumerRunnerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const registrations = this.discoveryService.discover();

    if (registrations.length === 0) {
      this.logger.log('No Kafka consumer handlers discovered.');
      return;
    }

    for (const registration of registrations) {
      this.logger.log(
        `Starting Kafka ${registration.kind} consumer for topic "${registration.topic}" (${registration.providerName}.${registration.methodName})`,
      );
    }

    await Promise.all(
      registrations.map((registration) =>
        this.runnerService.start(registration),
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.runnerService.stopAll();
  }
}
