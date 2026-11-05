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
  Req,
} from '@nestjs/common';
import {
  type AccessCredentialDto,
  type AccessCredentialWithSecretDto,
  type AccessSyncDeviceDto,
  type CustomerAccessSummaryDto,
  CreateTemporaryAccessSchema,
  SuspendCustomerAccessSchema,
  TestDeviceConnectionSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { resolveFacilityFilter } from '../../common/facility-scope';

import { AccessCredentialsService } from './access-credentials.service';
import { AccessDevicesService } from './access-devices.service';
import { AccessIntegrationsService } from './access-integrations.service';
import { DahuaSyncService } from './dahua-sync.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateTemporaryAccessDto extends createZodDto(CreateTemporaryAccessSchema) {}
class SuspendCustomerAccessDto extends createZodDto(SuspendCustomerAccessSchema) {}
class TestDeviceConnectionDto extends createZodDto(TestDeviceConnectionSchema) {}

function meta(req: Request): RequestMeta {
  const userAgent = req.header('user-agent');
  return { ...(req.ip ? { ipAddress: req.ip } : {}), ...(userAgent ? { userAgent } : {}) };
}

/** Lo que cruza inquilinos, dispositivos y terminales. */
@RequireFeature('access_control')
@Controller('access')
export class AccessToolsController {
  constructor(
    private readonly credentials: AccessCredentialsService,
    private readonly devices: AccessDevicesService,
    private readonly integrations: AccessIntegrationsService,
    private readonly sync: DahuaSyncService,
  ) {}

  @RequirePermission('access:read')
  @Get('customers/:customerId')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<CustomerAccessSummaryDto> {
    return this.credentials.customerSummary(user.tenantId, customerId, user.facilityScope ?? null);
  }

  @RequirePermission('access:manage')
  @Post('customers/:customerId/suspend')
  @HttpCode(HttpStatus.OK)
  suspendAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Body() body: SuspendCustomerAccessDto,
    @Req() req: Request,
  ): Promise<{ changed: number }> {
    return this.credentials.suspendAllForCustomer({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId,
      reason: body.reason,
      facilityScope: user.facilityScope ?? null,
      meta: meta(req),
    });
  }

  @RequirePermission('access:manage')
  @Post('customers/:customerId/resume')
  @HttpCode(HttpStatus.OK)
  resumeAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
    @Req() req: Request,
  ): Promise<{ changed: number }> {
    return this.credentials.resumeAllForCustomer({
      tenantId: user.tenantId,
      userId: user.sub,
      customerId,
      facilityScope: user.facilityScope ?? null,
      meta: meta(req),
    });
  }

  @RequirePermission('access:manage')
  @Post('customers/:customerId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', new ParseUUIDPipe()) customerId: string,
  ): Promise<{ sentTo: string }> {
    return this.integrations.resendCode(user.tenantId, customerId, user.facilityScope ?? null);
  }

  @RequirePermission('access:read')
  @Get('temporary')
  temporary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<AccessCredentialDto[]> {
    return this.credentials.listTemporary(user.tenantId, user.facilityScope ?? null, facilityId);
  }

  @RequirePermission('access:manage')
  @Post('temporary')
  createTemporary(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateTemporaryAccessDto,
    @Req() req: Request,
  ): Promise<AccessCredentialWithSecretDto> {
    return this.credentials.createTemporary({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: meta(req),
    });
  }

  @RequirePermission('access:read')
  @Get('sync-status')
  async syncStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<AccessSyncDeviceDto[]> {
    const ids = resolveFacilityFilter(user.facilityScope ?? null, facilityId);
    if (ids === null) return [];
    return this.sync.status(user.tenantId, ids ?? null);
  }

  @RequirePermission('access:manage')
  @Post('devices/test-connection')
  @HttpCode(HttpStatus.OK)
  testConnection(
    @Body() body: TestDeviceConnectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ supported: boolean; online: boolean; message?: string }> {
    return this.devices.testConnection(user.tenantId, body);
  }

  @RequirePermission('access:manage')
  @Post('devices/:id/resync')
  @HttpCode(HttpStatus.OK)
  resync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ sent: number }> {
    return this.devices.resync(user.tenantId, id, user.facilityScope ?? null);
  }
}
