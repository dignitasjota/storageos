import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
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
  type TenantAeatCredentialMetadata,
  TenantAeatCredentialsService,
} from './tenant-aeat-credentials.service';

/**
 * Body multipart: el `file` viaja como Buffer en `@UploadedFile()`. La
 * contraseña llega como `string` en el body y se valida con Zod a mano porque
 * `createZodDto` se enfoca a JSON. El entorno ya no se elige (es el de la
 * plataforma): si llega, se ignora.
 */
const UploadFieldsSchema = z.object({
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

const RepresentativeBodySchema = z.object({
  name: z.string().trim().max(120).nullable(),
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
        message: 'Falta el archivo del certificado (.p12 o .pfx).',
      });
    }
    const parsed = UploadFieldsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_fields',
        message: 'Campos no válidos: falta la contraseña del certificado.',
        issues: parsed.error.flatten(),
      });
    }
    return this.service.upload({
      tenantId: user.tenantId,
      userId: user.sub,
      p12Buffer: file.buffer,
      password: parsed.data.password,
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

  /**
   * El certificado activo o `{ credential: null }` si aún no hay ninguno. Lo
   * usa el panel: no tener certificado no es un error (`GET me` da 404).
   */
  @RequirePermission('invoices:manage')
  @Get('current')
  async getCurrent(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ credential: TenantAeatCredentialMetadata | null }> {
    return { credential: await this.service.getMetadata(user.tenantId) };
  }

  @RequirePermission('invoices:manage')
  @Get('me')
  async getMine(@CurrentUser() user: AuthenticatedUser): Promise<TenantAeatCredentialMetadata> {
    const meta = await this.service.getMetadata(user.tenantId);
    if (!meta) {
      throw new NotFoundException({
        code: 'aeat_credential_not_found',
        message: 'No hay ningún certificado de la AEAT activo.',
      });
    }
    return meta;
  }

  /**
   * Nombre del representante con el que se envía a Veri*Factu cuando el
   * certificado es de otra persona o entidad (administrador, gestoría).
   */
  @RequirePermission('billing:configure')
  @Patch('me/representative')
  async setRepresentative(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ): Promise<TenantAeatCredentialMetadata> {
    const parsed = RepresentativeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_fields',
        message: 'Nombre del representante no válido.',
      });
    }
    return this.service.setRepresentativeName({
      tenantId: user.tenantId,
      userId: user.sub,
      name: parsed.data.name,
    });
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
        message: 'Indica el motivo para quitar el certificado.',
        issues: parsed.error.flatten(),
      });
    }
    const revoked = await this.service.revoke(user.tenantId, user.sub, parsed.data.reason);
    if (!revoked) {
      throw new NotFoundException({
        code: 'aeat_credential_not_found',
        message: 'No hay ningún certificado de la AEAT activo que quitar.',
      });
    }
  }
}
