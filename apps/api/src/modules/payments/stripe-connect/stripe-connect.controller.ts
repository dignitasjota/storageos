import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import {
  type StripeConnectLinkDto,
  type StripeConnectStatusDto,
  UpdateCardProviderSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';

import { StripeConnectService } from './stripe-connect.service';

class UpdateCardProviderBody extends createZodDto(UpdateCardProviderSchema) {}

/** Cuenta de Stripe del tenant para cobrar con tarjeta a sus inquilinos. */
@Controller('settings/stripe-connect')
export class StripeConnectController {
  constructor(private readonly connect: StripeConnectService) {}

  @RequirePermission('settings:read')
  @Get()
  status(@CurrentUser() user: AuthenticatedUser): Promise<StripeConnectStatusDto> {
    return this.connect.getStatus(user.tenantId);
  }

  /** Crea la cuenta si hace falta y devuelve el enlace al registro de Stripe. */
  @RequirePermission('billing:configure')
  @Post('onboarding-link')
  @HttpCode(HttpStatus.OK)
  onboarding(@CurrentUser() user: AuthenticatedUser): Promise<StripeConnectLinkDto> {
    return this.connect.startOnboarding(user.tenantId, user.sub);
  }

  @RequirePermission('billing:configure')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@CurrentUser() user: AuthenticatedUser): Promise<StripeConnectStatusDto> {
    return this.connect.refresh(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Post('dashboard-link')
  @HttpCode(HttpStatus.OK)
  dashboard(@CurrentUser() user: AuthenticatedUser): Promise<StripeConnectLinkDto> {
    return this.connect.dashboardLink(user.tenantId);
  }

  @RequirePermission('billing:configure')
  @Delete()
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<StripeConnectStatusDto> {
    return this.connect.disconnect(user.tenantId, user.sub);
  }

  @RequirePermission('billing:configure')
  @Put('card-provider')
  setCardProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateCardProviderBody,
  ): Promise<StripeConnectStatusDto> {
    return this.connect.setCardProvider(user.tenantId, user.sub, body.provider);
  }
}
