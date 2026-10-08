import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  OwnerStatementPeriodSchema,
  type OwnerStatementDto,
  SaveOwnerStatementSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { OwnerStatementsService } from './owner-statements.service';

class PeriodQueryDto extends createZodDto(OwnerStatementPeriodSchema) {}
class SaveStatementDto extends createZodDto(SaveOwnerStatementSchema) {}

/** Liquidaciones al propietario (plan Administrador). */
@Controller('owners/:ownerId/statements')
@RequireFeature('multi_owner')
export class OwnerStatementsController {
  constructor(private readonly service: OwnerStatementsService) {}

  /** Vista previa del periodo (sin guardar). */
  @RequirePermission('invoices:manage')
  @Get('preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
    @Query() q: PeriodQueryDto,
  ): Promise<OwnerStatementDto> {
    return this.service.compute(user.tenantId, ownerId, q.from, q.to);
  }

  @RequirePermission('invoices:manage')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
  ): Promise<OwnerStatementDto[]> {
    return this.service.list(user.tenantId, ownerId);
  }

  /** Guarda la liquidación del periodo y, por defecto, se la envía por email. */
  @RequirePermission('invoices:manage')
  @Post()
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
    @Body() body: SaveStatementDto,
  ): Promise<OwnerStatementDto> {
    return this.service.save({
      tenantId: user.tenantId,
      userId: user.sub,
      ownerId,
      from: body.from,
      to: body.to,
      send: body.send,
    });
  }
}
