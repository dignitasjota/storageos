import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@storageos/database';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { WhatsappCloudClient, WhatsappCloudError } from './whatsapp-cloud.client';

import type { Env } from '../../config/env.schema';
import type { RequestMeta } from '../auth/auth.service';
import type {
  UpdateWhatsappSettingsInput,
  WhatsappSettingsDto,
  WhatsappTestResultDto,
} from '@storageos/shared';

/** Credenciales descifradas de un tenant (solo para uso interno del módulo). */
export interface ResolvedWhatsappSettings {
  tenantId: string;
  phoneNumberId: string;
  accessToken: string;
  enabled: boolean;
}

/** Configuración del número de WhatsApp Business de cada tenant. */
@Injectable()
export class WhatsappSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    private readonly client: WhatsappCloudClient,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private webhookUrl(): string {
    return `${this.config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '')}/webhooks/whatsapp`;
  }

  async get(tenantId: string): Promise<WhatsappSettingsDto> {
    const row = await this.prisma.withTenant(
      (tx) => tx.tenantWhatsappSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    if (!row) {
      return {
        configured: false,
        phoneNumberId: null,
        wabaId: null,
        displayPhone: null,
        verifiedName: null,
        tokenLast4: null,
        enabled: false,
        webButtonEnabled: true,
        lastCheckedAt: null,
        webhookUrl: this.webhookUrl(),
        webhookVerifyToken: null,
        appSecretConfigured: false,
      };
    }
    const token = this.decrypt(row.accessTokenEncrypted, tenantId);
    return {
      configured: true,
      phoneNumberId: row.phoneNumberId,
      wabaId: row.wabaId,
      displayPhone: row.displayPhone,
      verifiedName: row.verifiedName,
      tokenLast4: token ? token.slice(-4) : null,
      enabled: row.enabled,
      webButtonEnabled: row.webButtonEnabled,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      webhookUrl: this.webhookUrl(),
      webhookVerifyToken: row.webhookVerifyTokenEncrypted
        ? this.decrypt(row.webhookVerifyTokenEncrypted, tenantId)
        : null,
      appSecretConfigured: !!row.appSecretEncrypted,
    };
  }

  async update(args: {
    tenantId: string;
    userId: string;
    input: UpdateWhatsappSettingsInput;
    meta: RequestMeta;
  }): Promise<WhatsappSettingsDto> {
    const { tenantId, input } = args;
    const existing = await this.prisma.withTenant(
      (tx) => tx.tenantWhatsappSettings.findUnique({ where: { tenantId } }),
      tenantId,
    );
    const phoneNumberId = input.phoneNumberId ?? existing?.phoneNumberId;
    const accessToken =
      input.accessToken ??
      (existing ? this.decrypt(existing.accessTokenEncrypted, tenantId) : null);
    if (!phoneNumberId || !accessToken) {
      throw new BadRequestException({
        code: 'whatsapp_credentials_required',
        message: 'Indica el ID del número y el token de acceso',
      });
    }
    const enabled = input.enabled ?? existing?.enabled ?? false;

    // Al activar o cambiar credenciales se comprueba contra Meta (y se guardan
    // el número y el nombre que muestra WhatsApp).
    const credentialsChanged =
      input.accessToken !== undefined ||
      (input.phoneNumberId !== undefined && input.phoneNumberId !== existing?.phoneNumberId);
    let info: { displayPhone: string | null; verifiedName: string | null } | null = null;
    if (credentialsChanged || (enabled && !existing?.enabled)) {
      try {
        info = await this.client.getPhoneInfo(phoneNumberId, accessToken);
      } catch (err) {
        throw new BadRequestException({
          code: 'whatsapp_connection_failed',
          message:
            err instanceof WhatsappCloudError
              ? `WhatsApp no acepta estas credenciales: ${err.message}`
              : 'No se pudo comprobar el número con WhatsApp',
        });
      }
    }

    // Token de verificación del webhook propio del tenant (se genera una vez).
    const verifyToken =
      existing?.webhookVerifyTokenEncrypted && existing.webhookVerifyTokenHash
        ? null
        : `wa_${randomBytes(18).toString('base64url')}`;
    const data = {
      phoneNumberId,
      ...(verifyToken
        ? {
            webhookVerifyTokenEncrypted: this.crypto.encryptString(verifyToken, tenantId),
            webhookVerifyTokenHash: hashToken(verifyToken),
          }
        : {}),
      ...(input.appSecret !== undefined
        ? {
            appSecretEncrypted: input.appSecret
              ? this.crypto.encryptString(input.appSecret, tenantId)
              : null,
          }
        : {}),
      ...(input.wabaId !== undefined ? { wabaId: input.wabaId || null } : {}),
      accessTokenEncrypted: this.crypto.encryptString(accessToken, tenantId),
      enabled,
      ...(input.webButtonEnabled !== undefined ? { webButtonEnabled: input.webButtonEnabled } : {}),
      ...(info
        ? {
            displayPhone: info.displayPhone,
            verifiedName: info.verifiedName,
            lastCheckedAt: new Date(),
          }
        : {}),
    };
    try {
      await this.prisma.withTenant(
        (tx) =>
          tx.tenantWhatsappSettings.upsert({
            where: { tenantId },
            create: { tenantId, ...data },
            update: data,
          }),
        tenantId,
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'whatsapp_number_taken',
          message: 'Ese número de WhatsApp ya está conectado a otra cuenta',
        });
      }
      throw err;
    }
    await this.audit.write({
      tenantId,
      userId: args.userId,
      action: 'tenant.whatsapp.settings_changed',
      entityType: 'Tenant',
      entityId: tenantId,
      changes: {
        phoneNumberId,
        enabled,
        tokenChanged: input.accessToken !== undefined,
        ...(input.appSecret !== undefined ? { appSecretChanged: true } : {}),
        ...(input.webButtonEnabled !== undefined
          ? { webButtonEnabled: input.webButtonEnabled }
          : {}),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.get(tenantId);
  }

  /** Comprueba las credenciales guardadas contra Meta. */
  async test(tenantId: string): Promise<WhatsappTestResultDto> {
    const resolved = await this.resolveForTenant(tenantId);
    if (!resolved) {
      return { ok: false, displayPhone: null, verifiedName: null, error: 'Sin configurar' };
    }
    try {
      const info = await this.client.getPhoneInfo(resolved.phoneNumberId, resolved.accessToken);
      await this.prisma.withTenant(
        (tx) =>
          tx.tenantWhatsappSettings.update({
            where: { tenantId },
            data: { ...info, lastCheckedAt: new Date() },
          }),
        tenantId,
      );
      return { ok: true, ...info, error: null };
    } catch (err) {
      return {
        ok: false,
        displayPhone: null,
        verifiedName: null,
        error: err instanceof Error ? err.message : 'Error desconocido',
      };
    }
  }

  async resolveForTenant(tenantId: string): Promise<ResolvedWhatsappSettings | null> {
    const row = await this.admin.tenantWhatsappSettings.findUnique({ where: { tenantId } });
    return row ? this.toResolved(row) : null;
  }

  /** Tenant dueño de un número (webhook entrante, sin contexto de tenant). */
  async resolveByPhoneNumberId(phoneNumberId: string): Promise<ResolvedWhatsappSettings | null> {
    const row = await this.admin.tenantWhatsappSettings.findUnique({ where: { phoneNumberId } });
    return row ? this.toResolved(row) : null;
  }

  /** ¿Es el token de verificación del webhook de algún tenant? */
  async isTenantVerifyToken(token: string): Promise<boolean> {
    const row = await this.admin.tenantWhatsappSettings.findFirst({
      where: { webhookVerifyTokenHash: hashToken(token) },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Secreto de la app propia del tenant dueño de esos números (para comprobar
   * la firma de un aviso que no firmó la app de la plataforma). `null` si los
   * números son de varios tenants o el tenant no tiene secreto propio.
   */
  async appSecretForPhoneNumberIds(phoneNumberIds: string[]): Promise<string | null> {
    const ids = [...new Set(phoneNumberIds)];
    if (ids.length === 0) return null;
    const rows = await this.admin.tenantWhatsappSettings.findMany({
      where: { phoneNumberId: { in: ids } },
      select: { tenantId: true, appSecretEncrypted: true },
    });
    const tenants = new Set(rows.map((r) => r.tenantId));
    if (rows.length !== ids.length || tenants.size !== 1) return null;
    const row = rows[0]!;
    return row.appSecretEncrypted ? this.decrypt(row.appSecretEncrypted, row.tenantId) : null;
  }

  private toResolved(row: {
    tenantId: string;
    phoneNumberId: string;
    accessTokenEncrypted: string;
    enabled: boolean;
  }): ResolvedWhatsappSettings | null {
    const accessToken = this.decrypt(row.accessTokenEncrypted, row.tenantId);
    if (!accessToken) return null;
    return {
      tenantId: row.tenantId,
      phoneNumberId: row.phoneNumberId,
      accessToken,
      enabled: row.enabled,
    };
  }

  private decrypt(value: string, tenantId: string): string | null {
    try {
      return this.crypto.decryptString(value, tenantId);
    } catch {
      return null;
    }
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
