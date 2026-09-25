import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiErrorResponse,
  VALIDATION_FAILED,
} from '@app/filters/api-error-response.decorator';
import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { ApiAccessTokenAuth } from '@app/modules/auth/decorators/api-access-token-auth.decorator';
import { CurrentUser } from '@app/modules/auth/decorators/current-user.decorator';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InvoiceResponseDto } from './dto/invoice-response.dto';
import { InvoicesService } from './invoices.service';

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token).
// Minimal surface intentionally: POST/GET/GET-by-id only (CLAUDE.md sections 25-27) -
// Invoices become auditable financial state once Reservations exist, so no PATCH/DELETE.
@ApiTags('Invoices')
@ApiAccessTokenAuth()
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post()
  @ApiOperation({
    operationId: 'createInvoice',
    summary: 'Create invoice',
    description:
      'Creates an OPEN Invoice. A non-USD amount is converted to USD once via Frankfurter and that FX snapshot is stored permanently; USD uses rate 1 without calling the provider.',
  })
  @ApiCreatedResponse({ type: InvoiceResponseDto })
  @ApiErrorResponse(
    400,
    VALIDATION_FAILED,
    'Amount is not a valid decimal',
    'Currency is not supported by the FX provider',
  )
  @ApiErrorResponse(
    500,
    'FX provider unavailable or returned an invalid response (non-USD only); nothing is persisted',
  )
  async create(
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.create(dto, user.id);
    return new InvoiceResponseDto(invoice);
  }

  @Get()
  @ApiOperation({ operationId: 'listInvoices', summary: 'List invoices' })
  @ApiOkResponse({ type: InvoiceResponseDto, isArray: true })
  async list(): Promise<InvoiceResponseDto[]> {
    const invoices = await this.invoicesService.list();
    return invoices.map((invoice) => new InvoiceResponseDto(invoice));
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getInvoice', summary: 'Get an invoice' })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Invoice id',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiOkResponse({ type: InvoiceResponseDto })
  @ApiErrorResponse(400, VALIDATION_FAILED)
  @ApiErrorResponse(404, 'Invoice not found')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.get(id);
    return new InvoiceResponseDto(invoice);
  }
}
