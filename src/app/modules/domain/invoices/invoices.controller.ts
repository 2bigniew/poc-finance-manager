import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { AuthenticatedUser } from '@app/modules/auth/authenticated-user.interface';
import { CurrentUser } from '@app/modules/auth/decorators/current-user.decorator';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { InvoiceResponseDto } from './dto/invoice-response.dto';
import { InvoicesService } from './invoices.service';

// Every route here is protected by the global JwtAccessGuard by default - none of them
// are @Public() (SECURITY.md: all domain endpoints require a JWT access token).
// Minimal surface intentionally: POST/GET/GET-by-id only (CLAUDE.md sections 25-27) -
// Invoices become auditable financial state once Reservations exist, so no PATCH/DELETE.
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post()
  async create(
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.create(dto, user.id);
    return new InvoiceResponseDto(invoice);
  }

  @Get()
  async list(): Promise<InvoiceResponseDto[]> {
    const invoices = await this.invoicesService.list();
    return invoices.map((invoice) => new InvoiceResponseDto(invoice));
  }

  @Get(':id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceResponseDto> {
    const invoice = await this.invoicesService.get(id);
    return new InvoiceResponseDto(invoice);
  }
}
