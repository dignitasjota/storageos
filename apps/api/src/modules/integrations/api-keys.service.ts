import { randomBytes } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { ApiKey, Prisma } from '@storageos/database';
import type {
  ApiKeyDto,
  ApiKeyScope,
  ApiKeyWithPlaintextDto,
  CreateApiKeyInput,
} from '@storageos/shared';

/**
 * Formato del token: `sk_live_<tenantId>.<secret>`. El tenantId va en
 * claro para poder buscar la fila sin escanear toda la tabla; el secret
 * (32 bytes random base64url) se guarda hasheado con argon2id.
 */
const API_KEY_PREFIX = 'sk_live_';

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

function buildPlaintext(tenantId: string, secret: string): string {
  return `${API_KEY_PREFIX}${tenantId}.${secret}`;
}

function buildKeyPrefix(tenantId: string): string {
  return `${API_KEY_PREFIX}${tenantId}`;
}

/**
 * Parsea un token recibido en `Authorization: Bearer <token>`. Si no
 * cumple el formato, devuelve `null` (NO lanza, para no leakear
 * informacion al cliente; el guard responde 401 generico).
 */
export function parseApiKey(token: string): { tenantId: string; secret: string } | null {
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  const rest = token.slice(API_KEY_PREFIX.length);
  const dotIdx = rest.indexOf('.');
  if (dotIdx === -1) return null;
  const tenantId = rest.slice(0, dotIdx);
  const secret = rest.slice(dotIdx + 1);
  // UUID v7 tiene 36 chars con guiones.
  if (tenantId.length !== 36 || secret.length < 10) return null;
  return { tenantId, secret };
}

export interface ApiKeyVerifyResult {
  tenantId: string;
  apiKeyId: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<ApiKeyDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.apiKey.findMany({
          orderBy: [{ createdAt: 'desc' }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateApiKeyInput;
    meta: RequestMeta;
  }): Promise<ApiKeyWithPlaintextDto> {
    const secret = generateSecret();
    const keyHash = await argonHash(secret);
    const keyPrefix = buildKeyPrefix(args.tenantId);
    const data: Prisma.ApiKeyUncheckedCreateInput = {
      tenantId: args.tenantId,
      name: args.input.name,
      keyPrefix,
      keyHash,
      scopes: args.input.scopes,
      createdByUserId: args.userId,
    };
    const created = await this.prisma.withTenant((tx) => tx.apiKey.create({ data }), args.tenantId);
    await this.writeAudit('integration.api_key_created', args, created.id);
    return {
      ...this.toDto(created),
      keyPlaintext: buildPlaintext(args.tenantId, secret),
    };
  }

  async revoke(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<ApiKeyDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.apiKey.update({
          where: { id: args.id },
          data: { revokedAt: new Date() },
        }),
      args.tenantId,
    );
    await this.writeAudit('integration.api_key_revoked', args, args.id);
    return this.toDto(updated);
  }

  /**
   * Verifica un token recibido en `Authorization: Bearer <token>`. Usa el
   * cliente admin (bypass RLS) porque la peticion entrante aun no tiene
   * tenant context. Si OK, actualiza `lastUsedAt` (best-effort, sin
   * bloquear el resultado).
   */
  async verify(token: string): Promise<ApiKeyVerifyResult | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    const candidates = await this.admin.apiKey.findMany({
      where: {
        tenantId: parsed.tenantId,
        revokedAt: null,
      },
      take: 50,
    });
    for (const candidate of candidates) {
      try {
        const ok = await argonVerify(candidate.keyHash, parsed.secret);
        if (!ok) continue;
        // best-effort: si falla, no bloqueamos la auth.
        this.admin.apiKey
          .update({ where: { id: candidate.id }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
        return { tenantId: candidate.tenantId, apiKeyId: candidate.id };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async findOrThrow(tenantId: string, id: string): Promise<ApiKey> {
    const row = await this.prisma.withTenant(
      (tx) => tx.apiKey.findFirst({ where: { id } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'api_key_not_found',
        message: 'API key no encontrada',
      });
    }
    return row;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      action,
      tenantId: args.tenantId,
      userId: args.userId,
      entityType: 'ApiKey',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(k: ApiKey): ApiKeyDto {
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes as ApiKeyScope[],
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
      createdByUserId: k.createdByUserId,
    };
  }
}
