import { randomBytes, randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import { API_KEY_SCOPES, API_KEY_WILDCARD_SCOPE, isKnownApiKeyScope } from './api-key-scopes';

import type { RequestMeta } from '../auth/auth.service';
import type { ApiKey, Prisma } from '@storageos/database';
import type {
  ApiKeyDto,
  ApiKeyScope,
  ApiKeyWithPlaintextDto,
  CreateApiKeyInput,
} from '@storageos/shared';

/**
 * Formato del token: `sk_live_<tenantId>.<idClave>_<secreto>`. El tenant y el
 * id de la clave (32 hex, sin guiones) van en claro para ir directos a su fila:
 * un token falso cuesta como mucho una comprobación argon2. El secreto (32
 * bytes base64url) se guarda con hash argon2id.
 *
 * Las claves antiguas (`sk_live_<tenantId>.<secreto>`) siguen valiendo: se
 * reconocen porque su `keyPrefix` es solo `sk_live_<tenantId>`.
 */
const API_KEY_PREFIX = 'sk_live_';
/** Como mucho se prueban estas claves antiguas por token (argon2 es caro). */
const LEGACY_CANDIDATES = 5;
const KEY_ID_RE = /^([0-9a-f]{32})_(.{10,})$/;

function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

function compactId(id: string): string {
  return id.replace(/-/g, '');
}

function expandId(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildPlaintext(tenantId: string, keyId: string, secret: string): string {
  return `${API_KEY_PREFIX}${tenantId}.${compactId(keyId)}_${secret}`;
}

function legacyKeyPrefix(tenantId: string): string {
  return `${API_KEY_PREFIX}${tenantId}`;
}

function buildKeyPrefix(tenantId: string, keyId: string): string {
  return `${legacyKeyPrefix(tenantId)}.${compactId(keyId)}`;
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
  scopes: string[];
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
    const normalizedScopes = this.normalizeScopes(args.input.scopes);
    const id = randomUUID();
    const secret = generateSecret();
    const keyHash = await argonHash(secret);
    const keyPrefix = buildKeyPrefix(args.tenantId, id);
    const data: Prisma.ApiKeyUncheckedCreateInput = {
      id,
      tenantId: args.tenantId,
      name: args.input.name,
      keyPrefix,
      keyHash,
      scopes: normalizedScopes,
      createdByUserId: args.userId,
    };
    const created = await this.prisma.withTenant((tx) => tx.apiKey.create({ data }), args.tenantId);
    await this.writeAudit('integration.api_key_created', args, created.id);
    return {
      ...this.toDto(created),
      keyPlaintext: buildPlaintext(args.tenantId, id, secret),
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
    const withId = KEY_ID_RE.exec(parsed.secret);
    let secret = parsed.secret;
    let candidates: ApiKey[];
    if (withId) {
      // Clave nueva: una sola fila, una sola comprobación.
      secret = withId[2]!;
      const row = await this.admin.apiKey.findFirst({
        where: { id: expandId(withId[1]!), tenantId: parsed.tenantId, revokedAt: null },
      });
      candidates = row ? [row] : [];
    } else {
      // Clave antigua: solo las de formato antiguo y como mucho unas pocas.
      candidates = await this.admin.apiKey.findMany({
        where: {
          tenantId: parsed.tenantId,
          revokedAt: null,
          keyPrefix: legacyKeyPrefix(parsed.tenantId),
        },
        orderBy: { lastUsedAt: { sort: 'desc', nulls: 'last' } },
        take: LEGACY_CANDIDATES,
      });
    }
    for (const candidate of candidates) {
      try {
        const ok = await argonVerify(candidate.keyHash, secret);
        if (!ok) continue;
        // best-effort: si falla, no bloqueamos la auth.
        this.admin.apiKey
          .update({ where: { id: candidate.id }, data: { lastUsedAt: new Date() } })
          .catch(() => undefined);
        return {
          tenantId: candidate.tenantId,
          apiKeyId: candidate.id,
          scopes: candidate.scopes,
        };
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
        message: 'Clave de API no encontrada.',
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
      // El backend puede persistir `'*'` (wildcard interno) ademas de los
      // scopes publicos. Lo exponemos tal cual para que la UI pueda
      // distinguir "acceso total" del listado granular.
      scopes: k.scopes as ApiKeyScope[],
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
      createdByUserId: k.createdByUserId,
    };
  }

  /**
   * Normaliza los scopes recibidos del body:
   *   - `undefined` o `[]` -> 400 `scope_required`: una clave nueva tiene que
   *     decir qué puede hacer (las antiguas con `'*'` siguen valiendo).
   *   - array con valores -> valida que cada uno este en `API_KEY_SCOPES`;
   *     si alguno no esta, 400 `invalid_scope`. Si el cliente envia los 5
   *     scopes publicos, comprime a `['*']` para que un endpoint nuevo con
   *     scope futuro siga funcionando sin tener que rotar la key.
   */
  private normalizeScopes(scopes: readonly string[] | undefined): string[] {
    if (!scopes || scopes.length === 0) {
      throw new BadRequestException({
        code: 'scope_required',
        message: 'Marca al menos un permiso para la clave.',
      });
    }
    const unknown = scopes.filter((s) => !isKnownApiKeyScope(s));
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'invalid_scope',
        message: `Permiso no reconocido: ${unknown.join(', ')}`,
        invalidScopes: unknown,
        allowedScopes: API_KEY_SCOPES,
      });
    }
    const unique = Array.from(new Set(scopes));
    if (unique.length === API_KEY_SCOPES.length) return [API_KEY_WILDCARD_SCOPE];
    return unique;
  }
}
