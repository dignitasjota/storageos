import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { InvoicesService } from './invoices.service';

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
}
