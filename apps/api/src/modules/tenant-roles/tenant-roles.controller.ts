import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AssignTenantRoleSchema,
  AssignUserFacilitiesSchema,
  CreateTenantRoleSchema,
  type TenantRoleDto,
  UpdateTenantRoleSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { type RoleActor, TenantRolesService } from './tenant-roles.service';

import type { Request } from 'express';

function actorOf(user: AuthenticatedUser, req: Request): RoleActor {
  return {
    userId: user.sub,
    role: user.role,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

class CreateTenantRoleDto extends createZodDto(CreateTenantRoleSchema) {}
class UpdateTenantRoleDto extends createZodDto(UpdateTenantRoleSchema) {}
class AssignTenantRoleDto extends createZodDto(AssignTenantRoleSchema) {}
class AssignUserFacilitiesDto extends createZodDto(AssignUserFacilitiesSchema) {}

@ApiTags('Settings')
@ApiBearerAuth('jwt')
@Controller('settings')
@RequirePermission('settings:manage')
export class TenantRolesController {
  constructor(private readonly service: TenantRolesService) {}

  @Get('roles')
  list(@CurrentUser() user: AuthenticatedUser): Promise<TenantRoleDto[]> {
    return this.service.list(user.tenantId);
  }

  @Post('roles')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateTenantRoleDto,
    @Req() req: Request,
  ): Promise<TenantRoleDto> {
    return this.service.create(user.tenantId, input, actorOf(user, req));
  }

  @Patch('roles/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateTenantRoleDto,
    @Req() req: Request,
  ): Promise<TenantRoleDto> {
    return this.service.update(user.tenantId, id, input, actorOf(user, req));
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.remove(user.tenantId, id, actorOf(user, req));
  }

  @Patch('users/:userId/tenant-role')
  @HttpCode(HttpStatus.NO_CONTENT)
  async assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: AssignTenantRoleDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.assignToUser(user.tenantId, userId, input.tenantRoleId, actorOf(user, req));
  }

  /** Permisos por local: fija los locales a los que se restringe un usuario. */
  @Patch('users/:userId/facilities')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setFacilities(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: AssignUserFacilitiesDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.service.setUserFacilities(
      user.tenantId,
      userId,
      input.facilityIds,
      actorOf(user, req),
    );
  }
}
