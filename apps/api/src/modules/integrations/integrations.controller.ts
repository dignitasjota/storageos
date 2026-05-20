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
  Query,
  Req,
} from '@nestjs/common';
import {
  type ApiKeyDto,
  type ApiKeyWithPlaintextDto,
  CreateApiKeySchema,
  CreateWebhookSchema,
  UpdateWebhookSchema,
  type WebhookDeliveryDto,
  type WebhookDto,
  type WebhookWithSecretDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { ApiKeysService } from './api-keys.service';
import { WebhooksService } from './webhooks.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateApiKeyDto extends createZodDto(CreateApiKeySchema) {}
class CreateWebhookDto extends createZodDto(CreateWebhookSchema) {}
class UpdateWebhookDto extends createZodDto(UpdateWebhookSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

/**
 * Endpoints de panel para gestionar API keys y webhooks salientes del
 * tenant. Solo roles `owner` y `manager` pueden listar; las acciones
 * destructivas (revoke, rotate-secret) requieren `owner`.
 */
@Controller('settings')
export class IntegrationsController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly webhooks: WebhooksService,
  ) {}

  // ---------------------- API keys ----------------------

  @Get('api-keys')
  @Roles('owner', 'manager')
  listApiKeys(@CurrentUser() user: AuthenticatedUser): Promise<ApiKeyDto[]> {
    return this.apiKeys.list(user.tenantId);
  }

  @Post('api-keys')
  @Roles('owner')
  createApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateApiKeyDto,
    @Req() req: Request,
  ): Promise<ApiKeyWithPlaintextDto> {
    return this.apiKeys.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Delete('api-keys/:id')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  revokeApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ApiKeyDto> {
    return this.apiKeys.revoke({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }

  // ---------------------- Webhooks ----------------------

  @Get('webhooks')
  @Roles('owner', 'manager')
  listWebhooks(@CurrentUser() user: AuthenticatedUser): Promise<WebhookDto[]> {
    return this.webhooks.list(user.tenantId);
  }

  @Post('webhooks')
  @Roles('owner')
  createWebhook(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateWebhookDto,
    @Req() req: Request,
  ): Promise<WebhookWithSecretDto> {
    return this.webhooks.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Patch('webhooks/:id')
  @Roles('owner')
  updateWebhook(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateWebhookDto,
    @Req() req: Request,
  ): Promise<WebhookDto> {
    return this.webhooks.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input: body,
      meta: extractMeta(req),
    });
  }

  @Delete('webhooks/:id')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  revokeWebhook(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<WebhookDto> {
    return this.webhooks.revoke({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }

  @Post('webhooks/:id/rotate-secret')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  rotateWebhookSecret(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<WebhookWithSecretDto> {
    return this.webhooks.rotateSecret({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }

  @Get('webhooks/:id/deliveries')
  @Roles('owner', 'manager')
  async listWebhookDeliveries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ items: WebhookDeliveryDto[]; nextCursor: string | null }> {
    const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw) || 50)) : 50;
    return this.webhooks.listDeliveries(user.tenantId, id, {
      limit,
      ...(cursor ? { cursor } : {}),
    });
  }
}
