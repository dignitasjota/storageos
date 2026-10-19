import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreatePaymentPlanSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CollectionsOpsService } from './collections-ops.service';
import { PaymentPlansService } from './payment-plans.service';

import type { ArrearsDto, MonthCollectionsDto, PaymentPlanDto } from '@storageos/shared';

class CreatePaymentPlanDto extends createZodDto(CreatePaymentPlanSchema) {}

/** Cobros del mes, impagos y planes de pago. */
@Controller()
export class CollectionsOpsController {
  constructor(
    private readonly ops: CollectionsOpsService,
    private readonly plans: PaymentPlansService,
  ) {}

  @Get('collections-month')
  @RequirePermission('payments:read')
  month(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<MonthCollectionsDto> {
    return this.ops.month(
      user.tenantId,
      month,
      user.facilityScope ?? null,
      facilityId || undefined,
    );
  }

  @Get('arrears')
  @RequirePermission('payments:read')
  arrears(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<ArrearsDto> {
    return this.ops.arrears(user.tenantId, user.facilityScope ?? null, facilityId || undefined);
  }

  @Get('payment-plans')
  @RequirePermission('payments:read')
  listPlans(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
  ): Promise<PaymentPlanDto[]> {
    return this.plans.list(user.tenantId, {
      ...(customerId ? { customerId } : {}),
      ...(status ? { status } : {}),
    });
  }

  @Post('payment-plans')
  @RequirePermission('payments:charge')
  createPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePaymentPlanDto,
  ): Promise<PaymentPlanDto> {
    return this.plans.create(user.tenantId, user.sub, body);
  }

  @Post('payment-plans/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payments:charge')
  cancelPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PaymentPlanDto> {
    return this.plans.cancel(user.tenantId, user.sub, id);
  }
}
