import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import {
  type ContractDto,
  DepositRegistryReceiptUploadSchema,
  UpdateDepositRegistrySchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { DepositRegistryService } from './deposit-registry.service';

import type { Request } from 'express';

class UpdateDepositRegistryDto extends createZodDto(UpdateDepositRegistrySchema) {}
class ReceiptUploadDto extends createZodDto(DepositRegistryReceiptUploadSchema) {}

/** Depósito de la fianza de una vivienda en el organismo autonómico. */
@Controller('contracts/:id/deposit-registry')
export class DepositRegistryController {
  constructor(private readonly service: DepositRegistryService) {}

  @RequirePermission('contracts:write')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateDepositRegistryDto,
    @Req() req: Request,
  ): Promise<ContractDto> {
    const ua = req.header('user-agent');
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      input: body,
      scope: user.facilityScope ?? null,
      meta: { ...(ua ? { userAgent: ua } : {}), ...(req.ip ? { ipAddress: req.ip } : {}) },
    });
  }

  @RequirePermission('contracts:write')
  @Post('receipt-upload-url')
  uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReceiptUploadDto,
  ) {
    return this.service.requestUploadUrl(
      user.tenantId,
      id,
      body.mimeType,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('contracts:read')
  @Get('receipt')
  receipt(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.receiptUrl(user.tenantId, id, user.facilityScope ?? null);
  }
}
