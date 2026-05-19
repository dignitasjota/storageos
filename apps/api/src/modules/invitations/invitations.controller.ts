import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AcceptInvitationSchema,
  type AuthSuccessResponse,
  type InvitationDto,
  InviteUserSchema,
  type PublicInvitationDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ThrottleLogin } from '../../common/decorators/throttle-presets';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { InvitationsService } from './invitations.service';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type { Request, Response } from 'express';

class InviteUserDto extends createZodDto(InviteUserSchema) {}
class AcceptInvitationDto extends createZodDto(AcceptInvitationSchema) {}

const REFRESH_COOKIE_NAME = 'refresh_token';
const COOKIE_PATH = '/';

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Roles('owner', 'manager')
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<InvitationDto[]> {
    return this.invitations.list(user.tenantId);
  }

  @Roles('owner', 'manager')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: InviteUserDto,
    @Req() req: Request,
  ): Promise<InvitationDto> {
    const inviter = await this.admin.user.findUniqueOrThrow({ where: { id: user.sub } });
    return this.invitations.create({
      tenantId: user.tenantId,
      inviterUserId: user.sub,
      inviterName: inviter.fullName,
      input,
      meta: extractMeta(req),
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.invitations.revoke({
      tenantId: user.tenantId,
      userId: user.sub,
      invitationId: id,
    });
  }

  @Roles('owner', 'manager')
  @Post(':id/resend')
  async resend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<InvitationDto> {
    const inviter = await this.admin.user.findUniqueOrThrow({ where: { id: user.sub } });
    return this.invitations.resend({
      tenantId: user.tenantId,
      userId: user.sub,
      inviterName: inviter.fullName,
      invitationId: id,
      meta: extractMeta(req),
    });
  }

  // ============================== publicos =================================

  @Public()
  @Get('token/:token')
  async findByToken(@Param('token') token: string): Promise<PublicInvitationDto> {
    return this.invitations.findByToken(token);
  }

  @Public()
  @ThrottleLogin()
  @Post('token/:token/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('token') token: string,
    @Body() input: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSuccessResponse> {
    const result = await this.invitations.accept(token, input, extractMeta(req));
    this.setRefreshCookie(res, result.refreshToken);
    return result.body;
  }

  private setRefreshCookie(res: Response, token: string): void {
    const ttlSeconds = this.config.get('JWT_REFRESH_TTL_SECONDS', { infer: true });
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE', { infer: true }),
      sameSite: this.config.get('COOKIE_SAMESITE', { infer: true }),
      domain: this.config.get('COOKIE_DOMAIN', { infer: true }),
      path: COOKIE_PATH,
      maxAge: ttlSeconds * 1000,
    });
  }
}
