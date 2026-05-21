import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { InvoicesService } from './invoices.service';

import type { InvoiceDto } from '@storageos/shared';

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
   * Reencola el envio de la factura a AEAT. Resetea `aeat_*` y mete un
   * nuevo job en la cola `verifactu` con 3 intentos + backoff exponencial.
   */
  @Roles('owner', 'manager')
  @Post(':id/resend-aeat')
  @HttpCode(HttpStatus.ACCEPTED)
  async resendAeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ queued: true; invoiceId: string }> {
    return this.invoices.resendAeat(id, user.tenantId);
  }

  /**
   * Consulta el estado actual de la factura en AEAT
   * (`ConsultaFactuSistemaFacturacion`). Actualiza `aeat_*` con la
   * respuesta y devuelve el DTO actualizado para que la UI pueda
   * refrescar el badge sin esperar al cron de polling.
   */
  @Roles('owner', 'manager')
  @Post(':id/refresh-aeat-status')
  @HttpCode(HttpStatus.OK)
  async refreshAeatStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceDto> {
    return this.invoices.refreshAeatStatus(id, user.tenantId);
  }
}
