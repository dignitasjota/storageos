import {
  BadRequestException,
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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ConfirmRemittanceSchema,
  CreateRemittanceSchema,
  CreateSepaMandateSchema,
  MarkSepaItemReturnedSchema,
  type RemittancePreviewDto,
  type SepaMandateDto,
  type SepaRemittanceDto,
  type SepaRemittancePrenoticeDto,
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
import { CompanyWideGuard } from '../../common/guards/company-wide.guard';

import { SepaService } from './sepa.service';

import type { Response } from 'express';

class UpdateSepaSettingsDto extends createZodDto(UpdateSepaSettingsSchema) {}
class CreateSepaMandateDto extends createZodDto(CreateSepaMandateSchema) {}
class CreateRemittanceDto extends createZodDto(CreateRemittanceSchema) {}
class MarkSepaItemReturnedDto extends createZodDto(MarkSepaItemReturnedSchema) {}

/**
 * Remesas SEPA y mandatos. La remesa es de toda la empresa: solo la usa quien
 * ve todos los locales (403 `company_wide_only`). Los mandatos son de cada
 * inquilino: quien ve algunos locales gestiona los de sus inquilinos.
 */
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
    @Query('customerId', new ParseUUIDPipe({ optional: true })) customerId?: string,
  ): Promise<SepaMandateDto[]> {
    return this.sepa.listMandates(user.tenantId, customerId, user.facilityScope ?? null);
  }

  @RequirePermission('payments:charge')
  @Post('mandates')
  createMandate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateSepaMandateDto,
  ): Promise<SepaMandateDto> {
    return this.sepa.createMandate(user.tenantId, body, { scope: user.facilityScope ?? null });
  }

  /** Vuelve a enviar al inquilino el enlace para firmar el mandato (y lo devuelve). */
  @RequirePermission('payments:charge')
  @Post('mandates/:id/signing-link')
  @HttpCode(HttpStatus.OK)
  resendSigningLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SepaMandateDto> {
    return this.sepa.resendSigningLink(user.tenantId, id, user.facilityScope ?? null);
  }

  /** PDF del mandato firmado en la app, con la constancia de la firma. */
  @RequirePermission('payments:read')
  @Get('mandates/:id/document')
  async mandateDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, pdf } = await this.sepa.mandatePdf(
      user.tenantId,
      id,
      user.facilityScope ?? null,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(pdf);
  }

  @RequirePermission('payments:charge')
  @Delete('mandates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelMandate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.sepa.cancelMandate(user.tenantId, id, user.facilityScope ?? null);
  }

  // -------- remesas --------

  @UseGuards(CompanyWideGuard)
  @RequirePermission('invoices:manage')
  @Post('remittances/preview')
  @HttpCode(HttpStatus.OK)
  preview(@CurrentUser() user: AuthenticatedUser): Promise<RemittancePreviewDto> {
    return this.sepa.previewRemittance(user.tenantId);
  }

  @UseGuards(CompanyWideGuard)
  @RequirePermission('payments:read')
  @Get('remittances')
  listRemittances(@CurrentUser() user: AuthenticatedUser): Promise<SepaRemittanceDto[]> {
    return this.sepa.listRemittances(user.tenantId);
  }

  @UseGuards(CompanyWideGuard)
  @RequirePermission('invoices:manage')
  @Post('remittances')
  createRemittance(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRemittanceDto,
  ): Promise<SepaRemittanceDto> {
    return this.sepa.createRemittance({ tenantId: user.tenantId, userId: user.sub, input: body });
  }

  @UseGuards(CompanyWideGuard)
  @RequirePermission('payments:read')
  @Get('remittances/:id/prenotices')
  prenotices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SepaRemittancePrenoticeDto[]> {
    return this.sepa.listPrenotices(user.tenantId, id);
  }

  @UseGuards(CompanyWideGuard)
  @RequirePermission('invoices:manage')
  @Get('remittances/:id/xml')
  getXml(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ filename: string; xml: string }> {
    return this.sepa.getXml(user.tenantId, id);
  }

  @UseGuards(CompanyWideGuard)
  @RequirePermission('invoices:manage')
  @Post('remittances/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<SepaRemittanceDto> {
    // Body opcional: sin él se cobran todos los adeudos.
    const parsed = ConfirmRemittanceSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_body',
        message: 'Adeudos rechazados no válidos',
      });
    }
    return this.sepa.confirmRemittance(user.tenantId, user.sub, id, parsed.data);
  }

  /** Cancela una remesa sin confirmar: sus facturas vuelven a poder cobrarse. */
  @UseGuards(CompanyWideGuard)
  @RequirePermission('invoices:manage')
  @Post('remittances/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SepaRemittanceDto> {
    return this.sepa.cancelRemittance(user.tenantId, id);
  }

  /** Un adeudo cobrado que el banco devolvió (sin fichero N43). */
  @UseGuards(CompanyWideGuard)
  @RequirePermission('invoices:manage')
  @Post('remittances/:id/items/:itemId/return')
  @HttpCode(HttpStatus.OK)
  markItemReturned(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: MarkSepaItemReturnedDto,
  ): Promise<SepaRemittanceDto> {
    return this.sepa.markItemReturned({
      tenantId: user.tenantId,
      userId: user.sub,
      remittanceId: id,
      itemId,
      input: body,
    });
  }

  /** Reenvía los preavisos que no salieron (remesa sin confirmar). */
  @UseGuards(CompanyWideGuard)
  @RequirePermission('invoices:manage')
  @Post('remittances/:id/prenotices/resend')
  @HttpCode(HttpStatus.OK)
  resendPrenotices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ resent: number }> {
    return this.sepa.resendPrenotices(user.tenantId, id);
  }
}
