import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../common/decorators/require-permission.decorator';

import { SavedMethodsSummaryService } from './saved-methods-summary.service';

import type { SavedPaymentMethodsSummaryDto } from '@storageos/shared';

@Controller('settings/payments')
export class SavedMethodsSummaryController {
  constructor(private readonly summary: SavedMethodsSummaryService) {}

  /**
   * Tarjetas y mandatos guardados de los inquilinos por pasarela: la pantalla
   * avisa de cuántos cobros dejan de hacerse antes de apagar una.
   */
  @RequireAnyPermission('settings:read', 'billing:configure')
  @Get('saved-methods-summary')
  get(@CurrentUser() user: AuthenticatedUser): Promise<SavedPaymentMethodsSummaryDto> {
    return this.summary.summary(user.tenantId);
  }
}
