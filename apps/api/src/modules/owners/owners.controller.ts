import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CreateOwnerSchema, type OwnerDto, UpdateOwnerSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { OwnersService } from './owners.service';

class CreateOwnerDto extends createZodDto(CreateOwnerSchema) {}
class UpdateOwnerDto extends createZodDto(UpdateOwnerSchema) {}

/** Propietarios (plan Administrador). */
@Controller('owners')
@RequireFeature('multi_owner')
export class OwnersController {
  constructor(private readonly service: OwnersService) {}

  @RequirePermission('facilities:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<OwnerDto[]> {
    return this.service.list(user.tenantId);
  }

  @RequirePermission('facilities:manage')
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateOwnerDto): Promise<OwnerDto> {
    return this.service.create({ tenantId: user.tenantId, userId: user.sub, input: body });
  }

  @RequirePermission('facilities:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateOwnerDto,
  ): Promise<OwnerDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      ownerId: id,
      input: body,
    });
  }
}
