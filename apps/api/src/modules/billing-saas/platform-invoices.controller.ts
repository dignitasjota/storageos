import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  IssuePlatformInvoiceSchema,
  UpdatePlatformBillingSettingsSchema,
  type PlatformBillingSettingsDto,
  type PlatformInvoiceDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';

import { PlatformInvoicesService } from './platform-invoices.service';

class UpdateSettingsDto extends createZodDto(UpdatePlatformBillingSettingsSchema) {}
class IssueDto extends createZodDto(IssuePlatformInvoiceSchema) {}

/** Facturación del SaaS (StorageOS → tenant). Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class PlatformInvoicesController {
  constructor(private readonly service: PlatformInvoicesService) {}

  @Get('platform-billing/settings')
  getSettings(): Promise<PlatformBillingSettingsDto> {
    return this.service.getSettings();
  }

  @Put('platform-billing/settings')
  updateSettings(@Body() body: UpdateSettingsDto): Promise<PlatformBillingSettingsDto> {
    return this.service.updateSettings(body);
  }

  @Get('tenants/:id/platform-invoices')
  listForTenant(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformInvoiceDto[]> {
    return this.service.listForTenant(id);
  }

  @Post('platform-invoices/issue')
  issue(@Body() body: IssueDto): Promise<PlatformInvoiceDto> {
    return this.service.issueForPayment(body.paymentId);
  }

  @Get('platform-invoices/:id/pdf')
  pdf(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ url: string }> {
    return this.service.getPdfUrl(id);
  }

  @Post('platform-invoices/:id/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resend(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.resend(id);
  }
}
