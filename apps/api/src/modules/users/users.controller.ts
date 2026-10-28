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
  NotFoundException,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ChangePasswordSchema,
  ConfirmEmailChangeSchema,
  type EmailChangeStatusDto,
  RequestEmailChangeSchema,
  UpdateProfileSchema,
  UpdateUserSchema,
  type UserSessionDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';
import { SessionsService } from '../auth/sessions.service';
import { TokensService } from '../auth/tokens.service';

import { UsersService } from './users.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
class RequestEmailChangeDto extends createZodDto(RequestEmailChangeSchema) {}
class ConfirmEmailChangeDto extends createZodDto(ConfirmEmailChangeSchema) {}

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
    private readonly sessions: SessionsService,
  ) {}

  /** Sesión de este navegador (por la cookie de refresh), si es del mismo tenant. */
  private currentSessionId(req: Request, tenantId: string): string | null {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const parsed = cookies?.['refresh_token']
      ? this.tokens.parseRefreshToken(cookies['refresh_token'])
      : null;
    return parsed && parsed.tenantId === tenantId ? parsed.sessionId : null;
  }

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

  @Get('me/email-change')
  async getEmailChange(@CurrentUser() user: AuthenticatedUser): Promise<EmailChangeStatusDto> {
    return this.users.getEmailChange(user.tenantId, user.sub);
  }

  /** Pide cambiar el email de acceso (se confirma desde el email nuevo). */
  @ThrottleLogin()
  @Post('me/email-change')
  async requestEmailChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: RequestEmailChangeDto,
    @Req() req: Request,
  ): Promise<EmailChangeStatusDto> {
    return this.users.requestEmailChange({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @Delete('me/email-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelEmailChange(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.users.cancelEmailChange(user.tenantId, user.sub);
  }

  /** Enlace del correo enviado al email nuevo (sin sesión). */
  @Public()
  @ThrottleLogin()
  @Post('email-change/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmEmailChange(
    @Body() input: ConfirmEmailChangeDto,
    @Req() req: Request,
  ): Promise<{ email: string }> {
    return this.users.confirmEmailChange(input.token, extractMeta(req));
  }

  /** Dispositivos con la sesión abierta. */
  @Get('me/sessions')
  async listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<UserSessionDto[]> {
    const current = this.currentSessionId(req, user.tenantId);
    const rows = await this.sessions.listActive(user.tenantId, user.sub);
    return rows.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      installedApp: s.installedApp,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === current,
    }));
  }

  @Delete('me/sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const ok = await this.sessions.revokeOwn({
      tenantId: user.tenantId,
      userId: user.sub,
      sessionId: id,
    });
    if (!ok)
      throw new NotFoundException({ code: 'session_not_found', message: 'Sesión no encontrada' });
  }

  /** Cierra las sesiones de los demás dispositivos (esta sigue abierta). */
  @Post('me/sessions/revoke-others')
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeOthers({
      tenantId: user.tenantId,
      userId: user.sub,
      keepSessionId: this.currentSessionId(req, user.tenantId),
    });
    return { revoked };
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
