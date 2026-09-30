import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { type EmailDomainResponseDto, UpsertEmailDomainSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { EmailDomainsService } from './email-domains.service';

import type { Request } from 'express';

class UpsertEmailDomainDto extends createZodDto(UpsertEmailDomainSchema) {}

/**
 * Dominio propio de correo del tenant. La lectura y el borrado no exigen la
 * funcionalidad (tras bajar de plan se puede consultar y quitar); dar de alta
 * y verificar sí (`custom_domain`, comprobado en el service).
 */
@Controller('settings/tenant/email-domain')
export class EmailDomainsController {
  constructor(private readonly service: EmailDomainsService) {}

  @Get()
  @RequirePermission('settings:read')
  async get(@CurrentUser() user: AuthenticatedUser): Promise<EmailDomainResponseDto> {
    return { emailDomain: await this.service.get(user.tenantId) };
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings:manage')
  async upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpsertEmailDomainDto,
    @Req() req: Request,
  ): Promise<EmailDomainResponseDto> {
    return { emailDomain: await this.service.upsert(actor(user, req), body) };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings:manage')
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<EmailDomainResponseDto> {
    return { emailDomain: await this.service.verify(actor(user, req)) };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('settings:manage')
  async remove(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    await this.service.remove(actor(user, req));
  }
}

function actor(user: AuthenticatedUser, req: Request) {
  return {
    tenantId: user.tenantId,
    userId: user.sub,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}
