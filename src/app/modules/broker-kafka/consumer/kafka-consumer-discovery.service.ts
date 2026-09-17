import { Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  KafkaHandlerMetadata,
  KafkaHandlerRegistration,
} from '../broker-kafka.types';
import { KafkaHandlerRegistrationError } from '../exceptions/kafka-handler-registration.error';
import { KAFKA_HANDLER_METADATA } from '../metadata/kafka-handler.metadata';

type HandlerMethod = (...args: unknown[]) => Promise<unknown>;

// Scans every NestJS provider for @ConsumeOneMessage/@ConsumeBatch decorated methods at
// startup and turns them into transport-agnostic KafkaHandlerRegistration objects. This
// is the only place that knows how a decorated provider method maps to a runnable
// handler; KafkaConsumerRunnerService only ever sees the resulting registrations
// (ARCHITECTURE.md: "Decorators register handlers during NestJS module discovery/
// bootstrap").
@Injectable()
export class KafkaConsumerDiscoveryService {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  discover(): KafkaHandlerRegistration[] {
    const registrations: KafkaHandlerRegistration[] = [];
    const seenHandlerKeys = new Set<string>();

    for (const wrapper of this.discoveryService.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance === null || typeof instance !== 'object') {
        continue;
      }

      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) {
        continue;
      }

      for (const methodName of this.metadataScanner.getAllMethodNames(
        prototype,
      )) {
        const registration = this.buildRegistration(
          instance,
          prototype,
          methodName,
          seenHandlerKeys,
        );
        if (registration) {
          registrations.push(registration);
        }
      }
    }

    return registrations;
  }

  private buildRegistration(
    instance: object,
    prototype: object,
    methodName: string,
    seenHandlerKeys: Set<string>,
  ): KafkaHandlerRegistration | null {
    // MetadataScanner.getAllMethodNames only ever returns names of function members, so
    // this lookup always succeeds; the undefined check below only satisfies
    // noUncheckedIndexedAccess.
    const methodRef = (prototype as Record<string, HandlerMethod>)[methodName];
    if (!methodRef) {
      return null;
    }

    const metadata: KafkaHandlerMetadata | undefined = this.reflector.get(
      KAFKA_HANDLER_METADATA,
      methodRef,
    );
    if (!metadata) {
      return null;
    }

    const providerName = instance.constructor.name;
    const handlerKey = `${metadata.kind}:${metadata.topic}`;
    if (seenHandlerKeys.has(handlerKey)) {
      throw new KafkaHandlerRegistrationError(
        `Duplicate Kafka ${metadata.kind} handler registered for topic "${metadata.topic}" (found on "${providerName}.${methodName}").`,
      );
    }
    seenHandlerKeys.add(handlerKey);

    if (metadata.kind === 'single') {
      return {
        id: handlerKey,
        kind: 'single',
        topic: metadata.topic,
        retry: metadata.retry,
        providerName,
        methodName,
        invoke: async (message) => {
          await methodRef.call(instance, message);
        },
      };
    }

    return {
      id: handlerKey,
      kind: 'batch',
      topic: metadata.topic,
      batchSize: metadata.batchSize,
      retry: metadata.retry,
      providerName,
      methodName,
      invoke: async (messages) => {
        await methodRef.call(instance, messages);
      },
    };
  }
}
