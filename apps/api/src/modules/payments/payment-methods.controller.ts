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
  Req,
} from '@nestjs/common';
import {
  CreateSetupIntentSchema,
  type PaymentMethodDto,
  RegisterPaymentMethodSchema,
  type SetupIntentResponseDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { PaymentMethodsService } from './payment-methods.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateSetupIntentDto extends createZodDto(CreateSetupIntentSchema) {}
class RegisterPaymentMethodDto extends createZodDto(RegisterPaymentMethodSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller()
export class PaymentMethodsController {
  constructor(private readonly pms: PaymentMethodsService) {}

  @RequirePermission('payments:read')
  @Get('customers/:customerId/payment-methods')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<PaymentMethodDto[]> {
    return this.pms.list(user.tenantId, customerId);
  }

  @RequirePermission('payments:charge')
  @Post('payment-methods/setup-intent')
  @HttpCode(HttpStatus.OK)
  async setupIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateSetupIntentDto,
  ): Promise<SetupIntentResponseDto> {
    return this.pms.createSetupIntent(user.tenantId, input);
  }

  @RequirePermission('payments:charge')
  @Post('payment-methods')
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: RegisterPaymentMethodDto,
    @Req() req: Request,
  ): Promise<PaymentMethodDto> {
    return this.pms.register({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('payments:charge')
  @Delete('payment-methods/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.pms.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      paymentMethodId: id,
      meta: extractMeta(req),
    });
  }
}
