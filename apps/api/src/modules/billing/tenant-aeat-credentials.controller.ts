import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { z } from 'zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import {
  type AeatEnvironment,
  type TenantAeatCredentialMetadata,
  TenantAeatCredentialsService,
} from './tenant-aeat-credentials.service';

/**
 * Body multipart: el `file` viaja como Buffer en `@UploadedFile()`. Los
 * campos de texto (password, environment) llegan como `string` en el body
 * y se validan con Zod manualmente porque `createZodDto` se enfoca a JSON.
 */
const UploadFieldsSchema = z.object({
  password: z.string().min(1, 'password requerido'),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
});

const RevokeBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

const P12_MAX_BYTES = 50 * 1024; // 50 KB es holgado para un PKCS#12 FNMT.

@ApiTags('Billing')
@ApiBearerAuth('jwt')
@Controller('billing/aeat-credentials')
export class TenantAeatCredentialsController {
  constructor(private readonly service: TenantAeatCredentialsService) {}

  @RequirePermission('billing:configure')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: P12_MAX_BYTES, files: 1 },
    }),
  )
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<TenantAeatCredentialMetadata> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        code: 'file_required',
        message: 'Falta el campo `file` (.p12/.pfx).',
      });
    }
    const parsed = UploadFieldsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_fields',
        message: 'Campos invalidos en el body.',
        issues: parsed.error.flatten(),
      });
    }
    const { password, environment } = parsed.data;
    return this.service.upload({
      tenantId: user.tenantId,
      userId: user.sub,
      p12Buffer: file.buffer,
      password,
      environment: environment as AeatEnvironment,
    });
  }

  /**
   * Histórico completo de credenciales del tenant (activas + revocadas).
   * Read-only; útil para auditar rotaciones desde Ajustes → Veri*Factu.
   */
  @RequirePermission('invoices:manage')
  @Get('history')
  async listHistory(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TenantAeatCredentialMetadata[]> {
    return this.service.listHistory(user.tenantId);
  }

  @RequirePermission('invoices:manage')
  @Get('me')
  async getMine(@CurrentUser() user: AuthenticatedUser): Promise<TenantAeatCredentialMetadata> {
    const meta = await this.service.getMetadata(user.tenantId);
    if (!meta) {
      throw new NotFoundException({
        code: 'aeat_credential_not_found',
        message: 'No hay credencial AEAT activa para este tenant.',
      });
    }
    return meta;
  }

  @RequirePermission('billing:configure')
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ): Promise<void> {
    const parsed = RevokeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_fields',
        message: 'Body invalido (reason requerido).',
        issues: parsed.error.flatten(),
      });
    }
    const revoked = await this.service.revoke(user.tenantId, user.sub, parsed.data.reason);
    if (!revoked) {
      throw new NotFoundException({
        code: 'aeat_credential_not_found',
        message: 'No hay credencial AEAT activa para revocar.',
      });
    }
  }
}
