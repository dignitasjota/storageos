import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { z } from 'zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import {
  type TenantAeatCredentialMetadata,
  TenantAeatCredentialsService,
} from '../billing/tenant-aeat-credentials.service';

import { OwnersService } from './owners.service';

const UploadFieldsSchema = z.object({
  password: z.string().min(1, 'password requerido'),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
});

const P12_MAX_BYTES = 50 * 1024;

/**
 * Certificado propio de un propietario para Veri*Factu (plan Administrador).
 * Sin él, sus facturas se envían con el certificado del tenant como
 * representante (el administrador debe estar apoderado en la AEAT).
 */
@Controller('owners/:ownerId/aeat-credential')
@RequireFeature('multi_owner')
export class OwnerAeatCredentialController {
  constructor(
    private readonly owners: OwnersService,
    private readonly credentials: TenantAeatCredentialsService,
  ) {}

  @RequirePermission('invoices:manage')
  @Get()
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
  ): Promise<{ credential: TenantAeatCredentialMetadata | null }> {
    await this.owners.findOrThrow(user.tenantId, ownerId);
    return { credential: await this.credentials.getMetadata(user.tenantId, ownerId) };
  }

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
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<TenantAeatCredentialMetadata> {
    await this.owners.findOrThrow(user.tenantId, ownerId);
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
      });
    }
    return this.credentials.upload({
      tenantId: user.tenantId,
      userId: user.sub,
      ownerId,
      p12Buffer: file.buffer,
      password: parsed.data.password,
      environment: parsed.data.environment,
    });
  }

  @RequirePermission('billing:configure')
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
  ): Promise<void> {
    await this.owners.findOrThrow(user.tenantId, ownerId);
    await this.credentials.revoke(user.tenantId, user.sub, 'revoked_by_user', ownerId);
  }
}
