import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { Invoice } from './invoice.entity';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

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

const authenticatedUser: AuthenticatedUser = {
  id: 'user-id',
  email: 'user@example.test',
  authMethod: 'jwt',
};

describe('InvoicesController', () => {
  let controller: InvoicesController;
  let invoicesService: {
    create: jest.Mock;
    get: jest.Mock;
    list: jest.Mock;
  };

  beforeEach(() => {
    invoicesService = {
      create: jest.fn(),
      get: jest.fn(),
      list: jest.fn(),
    };
    controller = new InvoicesController(
      invoicesService as unknown as InvoicesService,
    );
  });

  it('forwards CreateInvoiceDto and the current user id to InvoicesService.create', async () => {
    const dto: CreateInvoiceDto = {
      externalReference: 'INV-001',
      amount: '1000',
      currency: 'EUR',
    };
    const invoice = buildInvoice();
    invoicesService.create.mockResolvedValue(invoice);

    const result = await controller.create(dto, authenticatedUser);

    expect(invoicesService.create).toHaveBeenCalledWith(
      dto,
      authenticatedUser.id,
    );
    expect(result.id).toBe(invoice.id);
  });

  it('never lets the client choose createdByUserId - it always comes from @CurrentUser()', async () => {
    const dto: CreateInvoiceDto = {
      externalReference: 'INV-001',
      amount: '1000',
      currency: 'EUR',
    };
    invoicesService.create.mockResolvedValue(buildInvoice());

    await controller.create(dto, authenticatedUser);

    const [, createdByUserIdArg] = invoicesService.create.mock.calls[0] as [
      CreateInvoiceDto,
      string,
    ];
    expect(createdByUserIdArg).toBe(authenticatedUser.id);
  });

  it('returns a response list from InvoicesService.list', async () => {
    const invoices = [buildInvoice(), buildInvoice({ id: 'invoice-id-2' })];
    invoicesService.list.mockResolvedValue(invoices);

    const result = await controller.list();

    expect(invoicesService.list).toHaveBeenCalledWith();
    expect(result.map((dto) => dto.id)).toEqual(['invoice-id', 'invoice-id-2']);
  });

  it('forwards the id param to InvoicesService.get and returns the response DTO', async () => {
    const invoice = buildInvoice();
    invoicesService.get.mockResolvedValue(invoice);

    const result = await controller.get(invoice.id);

    expect(invoicesService.get).toHaveBeenCalledWith(invoice.id);
    expect(result.id).toBe(invoice.id);
  });

  it('only exposes rate/rateDate/source under conversion, not the redundant original/converted', async () => {
    const invoice = buildInvoice();
    invoicesService.get.mockResolvedValue(invoice);

    const result = await controller.get(invoice.id);

    expect(Object.keys(result.conversion).sort()).toEqual(
      ['rate', 'rateDate', 'source'].sort(),
    );
  });

  it('never exposes internal fields beyond the response DTO contract', async () => {
    const invoice = buildInvoice();
    invoicesService.get.mockResolvedValue(invoice);

    const result = await controller.get(invoice.id);

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'externalReference',
        'originalMoney',
        'convertedMoneyUsd',
        'conversion',
        'status',
        'createdByUserId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });
});
