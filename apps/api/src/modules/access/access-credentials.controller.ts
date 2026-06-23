import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type AccessCredentialDto,
  type AccessCredentialStatusValue,
  type AccessCredentialWithSecretDto,
  AccessCredentialStatusEnum,
  AccessMethodEnum,
  type AccessMethodValue,
  CreateCredentialSchema,
  RotateCredentialSchema,
  SuspendCredentialSchema,
  UpdateCredentialSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { AccessCredentialsService } from './access-credentials.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateCredentialDto extends createZodDto(CreateCredentialSchema) {}
class UpdateCredentialDto extends createZodDto(UpdateCredentialSchema) {}
class RotateCredentialDto extends createZodDto(RotateCredentialSchema) {}
class SuspendCredentialDto extends createZodDto(SuspendCredentialSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

function parseStatus(value: string | undefined): AccessCredentialStatusValue | undefined {
  if (!value) return undefined;
  const parsed = AccessCredentialStatusEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseMethod(value: string | undefined): AccessMethodValue | undefined {
  if (!value) return undefined;
  const parsed = AccessMethodEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

@Controller('access/credentials')
@RequireFeature('access_control')
export class AccessCredentialsController {
  constructor(private readonly service: AccessCredentialsService) {}

  @RequirePermission('access:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('method') method?: string,
  ): Promise<AccessCredentialDto[]> {
    const parsedStatus = parseStatus(status);
    const parsedMethod = parseMethod(method);
    return this.service.list(user.tenantId, {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(customerId ? { customerId } : {}),
      ...(parsedMethod ? { method: parsedMethod } : {}),
    });
  }

  @RequirePermission('access:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AccessCredentialDto> {
    return this.service.detail(user.tenantId, id);
  }

  @Post()
  @RequirePermission('access:manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialWithSecretDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch(':id')
  @RequirePermission('access:manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    return this.service.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Post(':id/rotate')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  rotate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RotateCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialWithSecretDto> {
    return this.service.rotate({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Post(':id/suspend')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SuspendCredentialDto,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    const [row] = await this.service.suspend({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
    return row!;
  }

  @Post(':id/resume')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  async resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    const [row] = await this.service.resume({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
    return row!;
  }

  @Post(':id/revoke')
  @RequirePermission('access:manage')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AccessCredentialDto> {
    return this.service.revoke({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }
}
