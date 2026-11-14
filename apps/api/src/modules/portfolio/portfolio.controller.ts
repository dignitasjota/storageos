import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  RenewalOfferSchema,
  RenewalWindowEnum,
  SetAnniversaryPctSchema,
  SetRentIncreaseExemptionSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertUuid } from '../../common/pagination';

import { PortfolioService } from './portfolio.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  ContractAnnexSentDto,
  PriceChangeRowDto,
  PriceHistoryDto,
  RenewalRowDto,
} from '@storageos/shared';
import type { Request } from 'express';

class RenewalOfferBody extends createZodDto(RenewalOfferSchema) {}
class ExemptionBody extends createZodDto(SetRentIncreaseExemptionSchema) {}
class AnniversaryPctBody extends createZodDto(SetAnniversaryPctSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/** Cartera: cuotas previstas, historial de cuota, renovaciones y excepciones. */
@Controller()
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  /** Todos los cambios de cuota previstos (programados, subidas y actualizaciones anuales). */
  @RequirePermission('contracts:read')
  @Get('portfolio/price-changes')
  priceChanges(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<PriceChangeRowDto[]> {
    if (facilityId) assertUuid(facilityId);
    return this.portfolio.priceChanges(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Bandeja de renovaciones: 30, 60, 90 días o vencidos. */
  @RequirePermission('contracts:read')
  @Get('portfolio/renewals')
  renewals(
    @CurrentUser() user: AuthenticatedUser,
    @Query('window') window?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<RenewalRowDto[]> {
    const parsed = RenewalWindowEnum.safeParse(window ?? '60');
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_window',
        message: 'El periodo tiene que ser 30, 60, 90 o overdue',
      });
    }
    if (facilityId) assertUuid(facilityId);
    return this.portfolio.renewals(user.tenantId, {
      window: parsed.data,
      ...(facilityId ? { facilityId } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** La cuota del contrato a lo largo del tiempo, con los cambios previstos. */
  @RequirePermission('contracts:read')
  @Get('contracts/:id/price-history')
  priceHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PriceHistoryDto> {
    return this.portfolio.priceHistory(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Oferta de renovación que el inquilino firma como anexo; al firmarla se renueva. */
  @RequirePermission('contracts:manage')
  @Post('contracts/:id/renewal-offer')
  renewalOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RenewalOfferBody,
    @Req() req: Request,
  ): Promise<ContractAnnexSentDto> {
    return this.portfolio.sendRenewalOffer({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: extractMeta(req),
    });
  }

  /** «No subir a este contrato hasta…» (subidas y actualización anual). */
  @RequirePermission('contracts:manage')
  @Put('contracts/:id/rent-increase-exemption')
  @HttpCode(HttpStatus.NO_CONTENT)
  setExemption(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ExemptionBody,
  ): Promise<void> {
    return this.portfolio.setExemption({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input: body,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** % propio de la actualización anual de este contrato (null = el del negocio). */
  @RequirePermission('contracts:manage')
  @Put('contracts/:id/anniversary-pct')
  @HttpCode(HttpStatus.NO_CONTENT)
  setAnniversaryPct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AnniversaryPctBody,
  ): Promise<void> {
    return this.portfolio.setAnniversaryPct({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input: body,
      facilityScope: user.facilityScope ?? null,
    });
  }
}
