import { Controller, Get } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

import { SupportAgilityService } from './support-agility.service';
import { SupportServiceStatusService } from './support-service-status.service';
import { SupportTicketsService } from './support-tickets.service';

import type {
  ServiceStatusDto,
  SupportResponseTimesDto,
  SupportTeammateDto,
} from '@storageos/shared';

/**
 * Lo que el negocio consulta en Soporte además de sus tickets: el estado del
 * servicio, lo que solemos tardar en responder y a quién puede poner en copia.
 */
@Controller('support')
export class SupportExtrasTenantController {
  constructor(
    private readonly status: SupportServiceStatusService,
    private readonly agility: SupportAgilityService,
    private readonly tickets: SupportTicketsService,
  ) {}

  @Get('service-status')
  serviceStatus(): Promise<ServiceStatusDto> {
    return this.status.get();
  }

  @Get('response-times')
  responseTimes(): Promise<SupportResponseTimesDto> {
    return this.agility.responseTimes();
  }

  @Get('teammates')
  teammates(@CurrentUser() user: AuthenticatedUser): Promise<SupportTeammateDto[]> {
    return this.tickets.listTeammates(user.tenantId, user.sub);
  }
}
