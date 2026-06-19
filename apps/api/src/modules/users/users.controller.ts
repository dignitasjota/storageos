import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { ChangePasswordSchema, UpdateProfileSchema, UpdateUserSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { TokensService } from '../auth/tokens.service';

import { UsersService } from './users.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@ApiTags('Users')
@ApiBearerAuth('jwt')
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
  ) {}

  // ============================ list/detail =================================

  @RequirePermission('users:read')
  @Get('users')
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.users.list(user.tenantId);
  }

  @RequirePermission('users:read')
  @Get('users/:id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.detail(user.tenantId, id);
  }

  // ============================ mutations ===================================

  @RequirePermission('users:manage')
  @Patch('users/:id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateUserDto,
    @Req() req: Request,
  ) {
    return this.users.update({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      actorRole: user.role,
      targetUserId: id,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('users:manage')
  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.users.deactivate({
      tenantId: user.tenantId,
      actorUserId: user.sub,
      targetUserId: id,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('users:manage')
  @Post('users/:id/transfer-ownership')
  @HttpCode(HttpStatus.NO_CONTENT)
  async transferOwnership(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.users.transferOwnership({
      tenantId: user.tenantId,
      fromUserId: user.sub,
      toUserId: id,
      meta: extractMeta(req),
    });
  }

  // ============================== /me =======================================

  @Patch('me')
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateProfileDto,
    @Req() req: Request,
  ) {
    return this.users.updateProfile({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @Post('me/change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const refresh = cookies?.['refresh_token'];
    const currentSessionId =
      refresh && this.tokens.parseRefreshToken(refresh)?.sessionId === undefined
        ? null
        : refresh
          ? (this.tokens.parseRefreshToken(refresh)?.sessionId ?? null)
          : null;

    // Defensa: la cookie debe pertenecer al mismo tenant.
    if (refresh) {
      const parsed = this.tokens.parseRefreshToken(refresh);
      if (parsed && parsed.tenantId !== user.tenantId) {
        throw new ForbiddenException({
          message: 'Cookie de sesion no valida',
          code: 'session_mismatch',
        });
      }
    }

    await this.users.changePassword({
      tenantId: user.tenantId,
      userId: user.sub,
      currentSessionId,
      input,
      meta: extractMeta(req),
    });
  }
}
