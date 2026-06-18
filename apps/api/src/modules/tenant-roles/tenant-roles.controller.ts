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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AssignTenantRoleSchema,
  CreateTenantRoleSchema,
  type TenantRoleDto,
  UpdateTenantRoleSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { TenantRolesService } from './tenant-roles.service';

class CreateTenantRoleDto extends createZodDto(CreateTenantRoleSchema) {}
class UpdateTenantRoleDto extends createZodDto(UpdateTenantRoleSchema) {}
class AssignTenantRoleDto extends createZodDto(AssignTenantRoleSchema) {}

@ApiTags('Settings')
@ApiBearerAuth('jwt')
@Controller('settings')
@Roles('owner')
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
  ): Promise<TenantRoleDto> {
    return this.service.create(user.tenantId, input);
  }

  @Patch('roles/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateTenantRoleDto,
  ): Promise<TenantRoleDto> {
    return this.service.update(user.tenantId, id, input);
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.remove(user.tenantId, id);
  }

  @Patch('users/:userId/tenant-role')
  @HttpCode(HttpStatus.NO_CONTENT)
  async assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() input: AssignTenantRoleDto,
  ): Promise<void> {
    await this.service.assignToUser(user.tenantId, userId, input.tenantRoleId);
  }
}
