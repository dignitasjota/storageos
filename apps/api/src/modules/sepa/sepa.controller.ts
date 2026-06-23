import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CreateRemittanceSchema,
  CreateSepaMandateSchema,
  type RemittancePreviewDto,
  type SepaMandateDto,
  type SepaRemittanceDto,
  type SepaSettingsDto,
  UpdateSepaSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { SepaService } from './sepa.service';

class UpdateSepaSettingsDto extends createZodDto(UpdateSepaSettingsSchema) {}
class CreateSepaMandateDto extends createZodDto(CreateSepaMandateSchema) {}
class CreateRemittanceDto extends createZodDto(CreateRemittanceSchema) {}

@Controller('sepa')
@RequireFeature('sepa')
export class SepaController {
  constructor(private readonly sepa: SepaService) {}

  // -------- config del acreedor --------

  @RequirePermission('settings:read')
  @Get('settings')
  getSettings(@CurrentUser() user: AuthenticatedUser): Promise<SepaSettingsDto> {
    return this.sepa.getSettings(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSepaSettingsDto,
  ): Promise<SepaSettingsDto> {
    return this.sepa.updateSettings(user.tenantId, body);
  }

  // -------- mandatos --------

  @RequirePermission('payments:read')
  @Get('mandates')
  listMandates(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId') customerId?: string,
  ): Promise<SepaMandateDto[]> {
    return this.sepa.listMandates(user.tenantId, customerId);
  }

  @RequirePermission('payments:charge')
  @Post('mandates')
  createMandate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateSepaMandateDto,
  ): Promise<SepaMandateDto> {
    return this.sepa.createMandate(user.tenantId, body);
  }

  @RequirePermission('payments:charge')
  @Delete('mandates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelMandate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.sepa.cancelMandate(user.tenantId, id);
  }

  // -------- remesas --------

  @RequirePermission('invoices:manage')
  @Post('remittances/preview')
  @HttpCode(HttpStatus.OK)
  preview(@CurrentUser() user: AuthenticatedUser): Promise<RemittancePreviewDto> {
    return this.sepa.previewRemittance(user.tenantId);
  }

  @RequirePermission('payments:read')
  @Get('remittances')
  listRemittances(@CurrentUser() user: AuthenticatedUser): Promise<SepaRemittanceDto[]> {
    return this.sepa.listRemittances(user.tenantId);
  }

  @RequirePermission('invoices:manage')
  @Post('remittances')
  createRemittance(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRemittanceDto,
  ): Promise<SepaRemittanceDto> {
    return this.sepa.createRemittance({ tenantId: user.tenantId, userId: user.sub, input: body });
  }

  @RequirePermission('invoices:manage')
  @Get('remittances/:id/xml')
  getXml(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ filename: string; xml: string }> {
    return this.sepa.getXml(user.tenantId, id);
  }

  @RequirePermission('invoices:manage')
  @Post('remittances/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SepaRemittanceDto> {
    return this.sepa.confirmRemittance(user.tenantId, user.sub, id);
  }
}
