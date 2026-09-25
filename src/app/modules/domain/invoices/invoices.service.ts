import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '@app/modules/database/types/database.interface';
import { CurrencyExchangeService } from '@app/modules/domain/shared/money/currency-exchange.service';
import { isNonNegativeDecimalString } from '@app/modules/domain/shared/money/decimal-math';
import { Money } from '@app/modules/domain/shared/money/money';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InvalidInvoiceAmountError } from './exceptions/invalid-invoice-amount.error';
import { InvoiceNotFoundError } from './exceptions/invoice-not-found.error';
import { Invoice } from './invoice.entity';
import { InvoicesRepository } from './invoices.repository';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly invoicesRepository: InvoicesRepository,
    private readonly currencyExchangeService: CurrencyExchangeService,
  ) {}

  async create(
    dto: CreateInvoiceDto,
    createdByUserId: string,
  ): Promise<Invoice> {
    if (!isNonNegativeDecimalString(dto.amount)) {
      throw new InvalidInvoiceAmountError(dto.amount);
    }

    const originalMoney: Money = {
      amount: dto.amount,
      currency: dto.currency,
    };

    // Fixed at creation time and never recomputed afterwards (CLAUDE.md section 18:
    // "Do not implement automatic revaluation/background FX refresh/read-time FX
    // recalculation").
    const conversion =
      await this.currencyExchangeService.convertToUsd(originalMoney);

    const now = new Date();
    const invoice = await this.invoicesRepository.create({
      id: randomUUID(),
      externalReference: dto.externalReference,
      originalAmount: conversion.original.amount,
      originalCurrency: conversion.original.currency,
      convertedAmountUsd: conversion.converted.amount,
      conversionRate: conversion.rate,
      conversionRateDate: conversion.rateDate,
      conversionSource: conversion.source,
      // New Invoices always start OPEN (BUSINESS.md); only future Reservation/Release
      // workflows transition to RESERVED/REPAID (CLAUDE.md section 15).
      status: 'OPEN',
      createdByUserId,
      createdAt: now,
      updatedAt: now,
    });

    this.logger.log(`Invoice created: ${invoice.id}`);
    return invoice;
  }

  async get(id: string): Promise<Invoice> {
    const invoice = await this.invoicesRepository.findById(id);
    if (!invoice) {
      throw new InvoiceNotFoundError(id);
    }

    return invoice;
  }

  async list(): Promise<Invoice[]> {
    return this.invoicesRepository.list();
  }

  // Transaction-aware contracts for other modules' capacity-changing transactions
  // (currently Reservations; later Release) - InvoicesRepository stays private to this
  // module (ARCHITECTURE.md), so these narrow pass-throughs are how a caller-owned `trx`
  // participates in an atomic Invoice state transition. Both return null on failure
  // (not found / precondition not met) rather than throwing a Reservation-specific
  // error: which typed error is appropriate is the caller's business decision, not
  // this module's (Invoices does not know Reservations exists).
  async findByIdForUpdate(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Invoice | null> {
    return this.invoicesRepository.findByIdForUpdate(id, executor);
  }

  async markReserved(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Invoice | null> {
    return this.invoicesRepository.updateStatus(
      id,
      'OPEN',
      'RESERVED',
      new Date(),
      executor,
    );
  }

  async markRepaid(
    id: string,
    executor: Kysely<Database>,
  ): Promise<Invoice | null> {
    return this.invoicesRepository.updateStatus(
      id,
      'RESERVED',
      'REPAID',
      new Date(),
      executor,
    );
  }
}
