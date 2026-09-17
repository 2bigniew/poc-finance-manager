import { CurrencyExchangeService } from '@app/modules/domain/shared/money/currency-exchange.service';
import { MoneyConversion } from '@app/modules/domain/shared/money/money-conversion';
import { InvalidInvoiceAmountError } from './exceptions/invalid-invoice-amount.error';
import { InvoiceNotFoundError } from './exceptions/invoice-not-found.error';
import { Invoice } from './invoice.entity';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'invoice-id',
    externalReference: 'INV-001',
    originalMoney: { amount: '1000.0000', currency: 'EUR' },
    convertedMoneyUsd: { amount: '1100.0000', currency: 'USD' },
    conversion: {
      original: { amount: '1000.0000', currency: 'EUR' },
      converted: { amount: '1100.0000', currency: 'USD' },
      rate: '1.1',
      rateDate: new Date('2026-01-15T00:00:00.000Z'),
      source: 'frankfurter.dev',
    },
    status: 'OPEN',
    createdByUserId: 'user-id',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildConversion(
  overrides: Partial<MoneyConversion> = {},
): MoneyConversion {
  return {
    original: { amount: '1000', currency: 'EUR' },
    converted: { amount: '1100.0000', currency: 'USD' },
    rate: '1.1',
    rateDate: new Date('2026-01-15T00:00:00.000Z'),
    source: 'frankfurter.dev',
    ...overrides,
  };
}

describe('InvoicesService', () => {
  let service: InvoicesService;
  let invoicesRepository: {
    create: jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
    findById: jest.Mock;
    list: jest.Mock;
  };
  let currencyExchangeService: {
    convertToUsd: jest.Mock<Promise<MoneyConversion>, [unknown]>;
  };

  beforeEach(() => {
    invoicesRepository = {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findById: jest.fn(),
      list: jest.fn(),
    };
    currencyExchangeService = {
      convertToUsd: jest.fn<Promise<MoneyConversion>, [unknown]>(),
    };

    service = new InvoicesService(
      invoicesRepository as unknown as InvoicesRepository,
      currencyExchangeService as unknown as CurrencyExchangeService,
    );
  });

  describe('create', () => {
    it('generates a UUID for the new invoice', async () => {
      currencyExchangeService.convertToUsd.mockResolvedValue(buildConversion());
      invoicesRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      const invoice = await service.create(
        { externalReference: 'INV-001', amount: '1000', currency: 'EUR' },
        'user-id',
      );

      expect(invoice.id).toMatch(UUID_PATTERN);
    });

    it('converts the original money to USD before persisting', async () => {
      currencyExchangeService.convertToUsd.mockResolvedValue(buildConversion());
      invoicesRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create(
        { externalReference: 'INV-001', amount: '1000', currency: 'EUR' },
        'user-id',
      );

      expect(currencyExchangeService.convertToUsd).toHaveBeenCalledWith({
        amount: '1000',
        currency: 'EUR',
      });
    });

    it('persists the exact conversion snapshot returned by CurrencyExchangeService', async () => {
      const conversion = buildConversion({
        rate: '1.0834',
        rateDate: new Date('2026-02-20T00:00:00.000Z'),
        converted: { amount: '1083.4000', currency: 'USD' },
      });
      currencyExchangeService.convertToUsd.mockResolvedValue(conversion);
      invoicesRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create(
        { externalReference: 'INV-001', amount: '1000', currency: 'EUR' },
        'user-id',
      );

      expect(invoicesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          originalAmount: '1000',
          originalCurrency: 'EUR',
          convertedAmountUsd: '1083.4000',
          conversionRate: '1.0834',
          conversionRateDate: new Date('2026-02-20T00:00:00.000Z'),
          conversionSource: 'frankfurter.dev',
        }),
      );
    });

    it('always sets status to OPEN, regardless of any client input', async () => {
      currencyExchangeService.convertToUsd.mockResolvedValue(buildConversion());
      invoicesRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create(
        { externalReference: 'INV-001', amount: '1000', currency: 'EUR' },
        'user-id',
      );

      expect(invoicesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'OPEN' }),
      );
    });

    it('uses the provided createdByUserId, never a client-supplied value', async () => {
      currencyExchangeService.convertToUsd.mockResolvedValue(buildConversion());
      invoicesRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      await service.create(
        { externalReference: 'INV-001', amount: '1000', currency: 'EUR' },
        'caller-user-id',
      );

      expect(invoicesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ createdByUserId: 'caller-user-id' }),
      );
    });

    it('sets createdAt/updatedAt timestamps', async () => {
      currencyExchangeService.convertToUsd.mockResolvedValue(buildConversion());
      invoicesRepository.create.mockImplementation((row: unknown) =>
        Promise.resolve(row),
      );

      const invoice = await service.create(
        { externalReference: 'INV-001', amount: '1000', currency: 'EUR' },
        'user-id',
      );

      expect(invoice.createdAt).toBeInstanceOf(Date);
      expect(invoice.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects an invalid amount without calling CurrencyExchangeService or the repository', async () => {
      await expect(
        service.create(
          {
            externalReference: 'INV-001',
            amount: 'not-a-number',
            currency: 'EUR',
          },
          'user-id',
        ),
      ).rejects.toBeInstanceOf(InvalidInvoiceAmountError);
      expect(currencyExchangeService.convertToUsd).not.toHaveBeenCalled();
      expect(invoicesRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a negative amount', async () => {
      await expect(
        service.create(
          { externalReference: 'INV-001', amount: '-100', currency: 'EUR' },
          'user-id',
        ),
      ).rejects.toBeInstanceOf(InvalidInvoiceAmountError);
    });

    it('propagates FX conversion failures without persisting anything', async () => {
      const error = new Error('fx unavailable');
      currencyExchangeService.convertToUsd.mockRejectedValue(error);

      await expect(
        service.create(
          { externalReference: 'INV-001', amount: '1000', currency: 'EUR' },
          'user-id',
        ),
      ).rejects.toBe(error);
      expect(invoicesRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns an existing invoice', async () => {
      const invoice = buildInvoice();
      invoicesRepository.findById.mockResolvedValue(invoice);

      await expect(service.get(invoice.id)).resolves.toBe(invoice);
    });

    it('throws InvoiceNotFoundError when missing', async () => {
      invoicesRepository.findById.mockResolvedValue(null);

      await expect(service.get('missing-id')).rejects.toBeInstanceOf(
        InvoiceNotFoundError,
      );
    });
  });

  describe('list', () => {
    it('returns invoices from the repository', async () => {
      const invoices = [buildInvoice()];
      invoicesRepository.list.mockResolvedValue(invoices);

      await expect(service.list()).resolves.toBe(invoices);
    });
  });
});
