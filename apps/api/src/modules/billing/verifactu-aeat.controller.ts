import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ResendAeatSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { InvoicesService } from './invoices.service';

import type { InvoiceDto, VerifactuRecordDto } from '@storageos/shared';

class ResendAeatDto extends createZodDto(ResendAeatSchema) {}

/**
 * Endpoints especificos del flujo Verifactu/AEAT que conviven con el
 * controller principal de `/invoices` pero bajo el prefijo `/billing/...`
 * (alineado con `tenant-aeat-credentials.controller.ts` y con la llamada
 * que ya hace el frontend desde `useResendVerifactuMutation`).
 */
@Controller('billing/invoices')
export class VerifactuAeatController {
  constructor(private readonly invoices: InvoicesService) {}

  /**
   * Vuelve a enviar a la AEAT: el mismo registro si no llegó, o uno de
   * subsanación con los datos corregidos si se rechazó o se aceptó con avisos.
   * Programa el envío de su emisor sin esperar al reintento.
   */
  @RequirePermission('invoices:manage')
  @Post(':id/resend-aeat')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendAeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: ResendAeatDto,
  ): Promise<{ queued: true; invoiceId: string; subsanacion: boolean }> {
    return this.invoices.resendAeat(id, user.tenantId, user.facilityScope ?? null, {
      userId: user.sub,
      reason: input?.reason ?? null,
    });
  }

  /** Los registros de Veri*Factu de la factura (alta, subsanaciones, anulación). */
  @RequirePermission('invoices:read')
  @Get(':id/verifactu-records')
  async records(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<VerifactuRecordDto[]> {
    return this.invoices.listVerifactuRecords(id, user.tenantId, user.facilityScope ?? null);
  }

  /**
   * Consulta el estado actual de la factura en AEAT
   * (`ConsultaFactuSistemaFacturacion`). Actualiza `aeat_*` con la
   * respuesta y devuelve el DTO actualizado para que la UI pueda
   * refrescar el badge sin esperar al cron de polling.
   */
  @RequirePermission('invoices:manage')
  @Post(':id/refresh-aeat-status')
  @HttpCode(HttpStatus.OK)
  async refreshAeatStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceDto> {
    return this.invoices.refreshAeatStatus(id, user.tenantId, user.facilityScope ?? null);
  }
}
