import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { accessWindowsFrom } from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart, zonedNextDayStart } from '../../common/format';
import { pageArgs, type PageRequest } from '../../common/pagination';
import { STARTED_CONTRACT_WHERE } from '../../common/pre-opening';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import { DahuaSyncService } from './dahua-sync.service';

import type { RequestMeta } from '../auth/auth.service';
import type {
  AccessCredential,
  AccessCredentialStatus,
  AccessMethod,
  Customer,
  CustomerType,
  Prisma,
} from '@storageos/database';
import type {
  AccessCredentialDto,
  AccessCredentialStatusValue,
  AccessCredentialWithSecretDto,
  AccessMethodValue,
  CreateCredentialInput,
  CreateFacialCredentialInput,
  NightPassListDto,
  PortalAccessCredentialDto,
  PortalAccessLogDto,
  RotateCredentialInput,
  SuspendCredentialInput,
  UpdateCredentialInput,
  VisitorPinDto,
  AccessLogDto,
  CreateTemporaryAccessInput,
  CustomerAccessSummaryDto,
} from '@storageos/shared';

interface ListFilters {
  /** live = lo que puede abrir algo (activas, suspendidas y pendientes). */
  status?: AccessCredentialStatusValue | 'live';
  customerId?: string;
  method?: AccessMethodValue;
  /** Búsqueda por nombre del inquilino. */
  search?: string;
  /** El local elegido en la cabecera. */
  facilityId?: string;
  page?: PageRequest;
  /** Permisos por local: si está, solo credenciales de clientes con contrato en esos locales. */
  facilityScope?: string[] | null;
}

type CredentialWithCustomer = AccessCredential & {
  customer?: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null;
};

const CUSTOMER_SELECT = {
  customer: {
    select: {
      customerType: true,
      firstName: true,
      lastName: true,
      companyName: true,
    },
  },
} satisfies Prisma.AccessCredentialInclude;

function customerDisplay(
  c: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null | undefined,
): string {
  if (!c) return 'Cliente';
  if (c.customerType === ('business' as CustomerType)) return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

/**
 * Tope de credenciales VIVAS que pueden compartir el mismo `secretPreview`
 * dentro de un tenant+método. `/access/verify` prefiltra por `secretPreview`
 * (4 caracteres) y verifica argon2 contra cada candidato hasta encontrar el
 * que casa — sin este tope, un tenant podía crear cientos de PIN/QR elegidos
 * para compartir preview y convertir una request HTTP de verificación en
 * cientos de verificaciones argon2 (amplificación de coste en un proceso
 * compartido por todos los tenants). Con el tope, el peor caso de ese bucle
 * queda acotado aquí mismo, en el momento de CREAR la credencial, en vez de
 * depender solo de reducir el límite de lectura en el propio verify.
 */
const MAX_CREDENTIALS_PER_PREVIEW = 20;

function generateRandomPin(): string {
  // 6 digitos: [100000, 999999]
  return randomInt(100000, 1000000).toString();
}

function generateQrToken(): string {
  // 24 chars base64url ~ 18 bytes
  return randomBytes(18).toString('base64url');
}

/** Próximas 08:00 en la hora del local, como ISO (caducidad del pase nocturno). */
function nextMorningIso(timeZone: string, hour = 8): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  let deltaMin = hour * 60 - (h * 60 + m);
  if (deltaMin <= 0) deltaMin += 1440; // ya pasó hoy → mañana
  return new Date(now.getTime() + deltaMin * 60_000).toISOString();
}

/** Pases nocturnos que se listan; las cifras de la página cuentan todos. */
const NIGHT_PASS_LIST_LIMIT = 500;

/** Accesos que el inquilino se da a sí mismo o a otros, además del suyo. */
const EXTRA_SOURCES = ['portal_self_service', 'portal_visitor', 'visitor', 'night_pass'];

/** Accesos temporales que se listan (los últimos). */
const MAX_TEMPORARY_LIST = 200;

/** Pases de visita que puede crear un inquilino al día desde su área de clientes. */
const VISITOR_PASSES_PER_DAY = 3;

@Injectable()
export class AccessCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly sync: DahuaSyncService,
    private readonly files: FilesService,
    private readonly admin: PrismaAdminService,
  ) {}

  /** ¿Tiene el inquilino el acceso cortado por una factura sin pagar? */
  async isCutForDebt(tenantId: string, customerId: string): Promise<boolean> {
    return this.prisma.withTenant(async (tx) => {
      const [credentials, actions] = await Promise.all([
        tx.accessCredential.count({
          where: {
            customerId,
            status: 'suspended' as AccessCredentialStatus,
            suspendReason: { startsWith: 'dunning:' },
          },
        }),
        tx.dunningAction.count({
          where: {
            actionType: 'access_block',
            status: 'executed',
            supersededAt: null,
            invoice: { customerId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
          },
        }),
      ]);
      return credentials + actions > 0;
    }, tenantId);
  }

  /** Quien tiene el acceso cortado no se da otro desde su área de clientes. */
  private async assertNotCutForDebt(tenantId: string, customerId: string): Promise<void> {
    if (await this.isCutForDebt(tenantId, customerId)) {
      throw new ConflictException({
        code: 'access_cut_for_debt',
        message: 'Tu acceso está cortado por un pago pendiente. Págalo para recuperarlo.',
      });
    }
  }

  /** Una misma tarjeta no puede estar viva en dos credenciales. */
  private async assertRfidFree(
    tenantId: string,
    rfidUid: string,
    exceptId?: string,
  ): Promise<void> {
    const taken = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.count({
          where: {
            method: 'rfid' as AccessMethod,
            rfidUid: { equals: rfidUid, mode: 'insensitive' },
            status: { in: ['active', 'suspended', 'pending'] as AccessCredentialStatus[] },
            ...(exceptId ? { id: { not: exceptId } } : {}),
          },
        }),
      tenantId,
    );
    if (taken > 0) {
      throw new ConflictException({
        code: 'rfid_in_use',
        message: 'Esa tarjeta ya la tiene otra credencial activa',
      });
    }
  }

  /**
   * Hasta dónde abre una credencial creada a mano. Lo normal son los trasteros
   * en uso del inquilino; abrirlo todo hay que pedirlo y no puede hacerlo quien
   * solo ve algunos locales.
   */
  private async resolveManualScope(args: {
    tenantId: string;
    customerId: string;
    allFacilities: boolean;
    allowedFacilityIds: string[];
    allowedUnitIds: string[];
    facilityScope: string[] | null | undefined;
  }): Promise<{ allowedFacilityIds: string[]; allowedUnitIds: string[] }> {
    if (args.allFacilities) {
      if (args.facilityScope) {
        throw new ForbiddenException({
          code: 'facility_not_in_scope',
          message: 'Solo puedes dar acceso a tus locales',
        });
      }
      return { allowedFacilityIds: [], allowedUnitIds: [] };
    }
    if (args.allowedFacilityIds.length > 0 || args.allowedUnitIds.length > 0) {
      for (const id of args.allowedFacilityIds) assertFacilityAllowed(args.facilityScope, id);
      const units = await this.prisma.withTenant(
        (tx) =>
          tx.unit.findMany({
            where: { id: { in: args.allowedUnitIds } },
            select: { facilityId: true },
          }),
        args.tenantId,
      );
      for (const u of units) assertFacilityAllowed(args.facilityScope, u.facilityId);
      return {
        // Un trastero suelto también abre la puerta de su local.
        allowedFacilityIds: [
          ...new Set([...args.allowedFacilityIds, ...units.map((u) => u.facilityId)]),
        ],
        allowedUnitIds: args.allowedUnitIds,
      };
    }
    const own = await this.customerScope(args.tenantId, args.customerId);
    if (own.allowedFacilityIds.length === 0) {
      throw new BadRequestException({
        code: 'credential_scope_required',
        message: 'Este inquilino no tiene trasteros en uso: elige qué locales abre',
      });
    }
    return own;
  }

  /**
   * ¿El PIN colisiona con otra credencial VIVA del mismo tenant? Como el verify
   * devuelve la PRIMERA credencial cuyo hash argon2 casa, dos credenciales con
   * el mismo PIN abrirían con la credencial (y restricciones) equivocada. Se
   * prefiltra por `secretPreview` (mismo prefijo) y se verifica argon2.
   */
  private async pinCollides(tenantId: string, pin: string): Promise<boolean> {
    const candidates = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: {
            tenantId,
            method: 'pin' as AccessMethod,
            secretPreview: pin.slice(-4),
            status: {
              in: ['active', 'suspended', 'pending'] as AccessCredentialStatus[],
            },
          },
          select: { secretHash: true },
        }),
      tenantId,
    );
    for (const c of candidates) {
      if (c.secretHash && (await argonVerify(c.secretHash, pin))) return true;
    }
    return false;
  }

  /** Cuántas credenciales vivas del tenant comparten ya este `secretPreview`. */
  private async countActiveByPreview(
    tenantId: string,
    method: 'pin' | 'qr',
    preview: string,
  ): Promise<number> {
    return this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.count({
          where: {
            tenantId,
            method: method as AccessMethod,
            secretPreview: preview,
            status: {
              in: ['active', 'suspended', 'pending'] as AccessCredentialStatus[],
            },
          },
        }),
      tenantId,
    );
  }

  /**
   * Resuelve el PIN a usar garantizando que NO colisione con otra credencial
   * viva del tenant, y que su `secretPreview` no esté ya saturado (ver
   * `MAX_CREDENTIALS_PER_PREVIEW`). Si el staff pasa un PIN concreto: 409 si
   * colisiona exactamente, 409 si el preview está saturado (caso extremo,
   * astronómicamente improbable con PINs elegidos de forma independiente).
   * Si no, genera uno aleatorio único (reintenta ante colisión o saturación).
   */
  private async resolveUniquePin(
    tenantId: string,
    providedPin: string | undefined,
  ): Promise<string> {
    if (providedPin !== undefined) {
      if (await this.pinCollides(tenantId, providedPin)) {
        throw new ConflictException({
          code: 'pin_collision',
          message: 'Ese PIN ya está en uso por otra credencial',
        });
      }
      const count = await this.countActiveByPreview(tenantId, 'pin', providedPin.slice(-4));
      if (count >= MAX_CREDENTIALS_PER_PREVIEW) {
        throw new ConflictException({
          code: 'pin_preview_saturated',
          message: 'Hay demasiadas credenciales con esos últimos dígitos; elige otro PIN',
        });
      }
      return providedPin;
    }
    for (let i = 0; i < 8; i++) {
      const pin = generateRandomPin();
      if (await this.pinCollides(tenantId, pin)) continue;
      const count = await this.countActiveByPreview(tenantId, 'pin', pin.slice(-4));
      if (count >= MAX_CREDENTIALS_PER_PREVIEW) continue;
      return pin;
    }
    return generateRandomPin(); // improbable tras 8 intentos; no bloquear el alta
  }

  /** Igual que `resolveUniquePin` pero para el token de QR (siempre auto-generado). */
  private async resolveUniqueQrToken(tenantId: string): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const token = generateQrToken();
      const count = await this.countActiveByPreview(tenantId, 'qr', token.slice(0, 4));
      if (count < MAX_CREDENTIALS_PER_PREVIEW) return token;
    }
    return generateQrToken(); // improbable tras 8 intentos; no bloquear el alta
  }

  async list(tenantId: string, filters: ListFilters): Promise<AccessCredentialDto[]> {
    const facilities = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facilities === null) return [];
    const where: Prisma.AccessCredentialWhereInput = {};
    if (filters.status === 'live') {
      where.status = { in: ['active', 'suspended', 'pending'] as AccessCredentialStatus[] };
      // Lo vencido que el repaso aún no ha marcado tampoco está vigente.
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
    } else if (filters.status) {
      where.status = filters.status as AccessCredentialStatus;
    }
    if (filters.method) where.method = filters.method as AccessMethod;
    // Los accesos temporales van en su pestaña.
    where.customerId = filters.customerId ?? { not: null };
    const customer: Prisma.CustomerWhereInput = {};
    if (facilities) {
      customer.contracts = { some: { unit: { facilityId: { in: facilities } } } };
    }
    const words = filters.search?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (words.length > 0) {
      customer.AND = words.map((w) => ({
        OR: [
          { firstName: { contains: w, mode: 'insensitive' as const } },
          { lastName: { contains: w, mode: 'insensitive' as const } },
          { companyName: { contains: w, mode: 'insensitive' as const } },
        ],
      }));
    }
    if (Object.keys(customer).length > 0) where.customer = customer;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where,
          include: CUSTOMER_SELECT,
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
          ...pageArgs(filters.page),
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Pases nocturnos del tenant (credenciales `metadata.source='night_pass'`) + ingresos. */
  async listNightPasses(
    tenantId: string,
    facilityScope?: string[] | null,
    facilityId?: string,
  ): Promise<NightPassListDto> {
    const facilities = resolveFacilityFilter(facilityScope, facilityId);
    return this.prisma.withTenant(async (tx) => {
      const rows =
        facilities === null
          ? []
          : await tx.accessCredential.findMany({
              where: {
                tenantId,
                metadata: { path: ['source'], equals: 'night_pass' },
                ...(facilities ? { allowedFacilityIds: { hasSome: facilities } } : {}),
              },
              include: CUSTOMER_SELECT,
              orderBy: { createdAt: 'desc' },
            });
      const now = new Date();
      const passes: NightPassListDto['passes'] = rows.map((r) => {
        let status: 'active' | 'used' | 'expired';
        if (r.usesCount >= 1) status = 'used';
        else if (
          r.status === 'revoked' ||
          r.status === 'expired' ||
          (r.expiresAt !== null && r.expiresAt < now)
        ) {
          status = 'expired';
        } else {
          status = 'active';
        }
        return {
          id: r.id,
          customerId: r.customerId as string,
          customerName: customerDisplay(r.customer),
          status,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        };
      });
      // Ingresos: suma de las líneas de factura «Pase nocturno» (excluye draft/cancelled).
      const items = await tx.invoiceItem.findMany({
        where: {
          invoice: {
            tenantId,
            status: { notIn: ['draft', 'cancelled'] },
            ...(facilities ? { facilityId: { in: facilities } } : {}),
          },
          description: { contains: 'Pase nocturno', mode: 'insensitive' },
        },
        select: { total: true },
      });
      const revenue = items.reduce((sum, it) => sum + Number(it.total), 0);
      return {
        // La tabla enseña los últimos; las cifras cuentan todos.
        passes: passes.slice(0, NIGHT_PASS_LIST_LIMIT),
        total: passes.length,
        active: passes.filter((p) => p.status === 'active').length,
        used: passes.filter((p) => p.status === 'used').length,
        expired: passes.filter((p) => p.status === 'expired').length,
        revenue: Math.round(revenue * 100) / 100,
      };
    }, tenantId);
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<AccessCredentialDto> {
    return this.toDto(await this.findOrThrow(tenantId, id, facilityScope));
  }

  async create(args: {
    tenantId: string;
    userId: string | null;
    input: CreateCredentialInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<AccessCredentialWithSecretDto> {
    const input = args.input;
    await this.assertCustomerInScope(args.tenantId, input.customerId, args.facilityScope);
    const isInternal = args.userId === null;
    const access = isInternal
      ? { allowedFacilityIds: input.allowedFacilityIds, allowedUnitIds: input.allowedUnitIds }
      : await this.resolveManualScope({
          tenantId: args.tenantId,
          customerId: input.customerId,
          allFacilities: input.allFacilities ?? false,
          allowedFacilityIds: input.allowedFacilityIds,
          allowedUnitIds: input.allowedUnitIds,
          facilityScope: args.facilityScope,
        });
    let secretHash: string | null = null;
    let secretPreview: string | null = null;
    let rfidUid: string | null = null;
    let revealedSecret: string | null = null;

    let secretEncrypted: string | null = null;
    if (input.method === 'pin') {
      const pin = await this.resolveUniquePin(args.tenantId, input.pin);
      secretHash = await argonHash(pin);
      secretPreview = pin.slice(-4);
      secretEncrypted = this.crypto.encryptString(pin, args.tenantId);
      revealedSecret = pin;
    } else if (input.method === 'qr') {
      const token = await this.resolveUniqueQrToken(args.tenantId);
      secretHash = await argonHash(token);
      secretPreview = token.slice(0, 4);
      secretEncrypted = this.crypto.encryptString(token, args.tenantId);
      revealedSecret = token;
    } else {
      // rfid (schema garantiza rfidUid presente)
      if (!input.rfidUid) {
        throw new ConflictException({
          code: 'rfid_uid_required',
          message: 'rfidUid requerido cuando method=rfid',
        });
      }
      await this.assertRfidFree(args.tenantId, input.rfidUid);
      rfidUid = input.rfidUid;
    }

    const now = new Date();
    const data: Prisma.AccessCredentialUncheckedCreateInput = {
      tenantId: args.tenantId,
      customerId: input.customerId,
      method: input.method as AccessMethod,
      status: 'active' as AccessCredentialStatus,
      label: input.label?.trim() || null,
      secretHash,
      secretPreview,
      secretEncrypted,
      rfidUid,
      allowedFacilityIds: access.allowedFacilityIds,
      allowedUnitIds: access.allowedUnitIds,
      allowedHours: input.allowedHours as Prisma.InputJsonValue,
      bypassCurfew: input.bypassCurfew,
      maxUses: input.maxUses ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      contractId: input.contractId ?? null,
      metadata: input.metadata as Prisma.InputJsonValue,
      activatedAt: now,
    };
    const created = await this.prisma.withTenant(
      (tx) => tx.accessCredential.create({ data, include: CUSTOMER_SELECT }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_created', args, created.id);
    // Patrón B: propaga la credencial a los terminales autónomos del scope (best-effort).
    await this.sync.syncCredential(args.tenantId, created.id);
    return { ...this.toDto(created), revealedSecret };
  }

  /**
   * Alta de una credencial FACIAL («tu cara es la llave»). La foto se guarda en
   * MinIO (bucket privado); el terminal (Patrón B) hace el matching offline con
   * la plantilla que le sincronizamos. Feature `facial_access` (add-on). Sin
   * scope explícito, se acota a los contratos vivos del inquilino (como el resto
   * de auto-emitidas — evita el bug de scope vacío = acceso a todo).
   */
  async createFacial(args: {
    tenantId: string;
    userId: string | null;
    input: CreateFacialCredentialInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<AccessCredentialDto> {
    const input = args.input;
    await this.assertCustomerInScope(args.tenantId, input.customerId, args.facilityScope);
    const scope =
      input.allowedFacilityIds || input.allowedUnitIds
        ? {
            allowedFacilityIds: input.allowedFacilityIds ?? [],
            allowedUnitIds: input.allowedUnitIds ?? [],
          }
        : await this.customerScope(args.tenantId, input.customerId);

    // Guarda la foto en MinIO (bucket privado); en BD solo la key.
    const ext = input.photoMimeType === 'image/png' ? 'png' : 'jpg';
    const key = `${args.tenantId}/customers/${input.customerId}/face/${randomUUID()}.${ext}`;
    await this.files.putObject({
      bucket: 'uploads',
      key,
      body: Buffer.from(input.photoBase64, 'base64'),
      contentType: input.photoMimeType,
    });

    const data: Prisma.AccessCredentialUncheckedCreateInput = {
      tenantId: args.tenantId,
      customerId: input.customerId,
      method: 'face' as AccessMethod,
      status: 'active' as AccessCredentialStatus,
      label: input.label?.trim() || 'Reconocimiento facial',
      facePhotoKey: key,
      allowedFacilityIds: scope.allowedFacilityIds,
      allowedUnitIds: scope.allowedUnitIds,
      activatedAt: new Date(),
    };
    const created = await this.prisma.withTenant(
      (tx) => tx.accessCredential.create({ data, include: CUSTOMER_SELECT }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_created', args, created.id);
    await this.sync.syncCredential(args.tenantId, created.id);
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string | null;
    id: string;
    input: UpdateCredentialInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<AccessCredentialDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    const data: Prisma.AccessCredentialUncheckedUpdateInput = {};
    const input = args.input;
    if (input.label !== undefined) data.label = input.label?.trim() || null;
    const scopeChanged =
      input.allFacilities !== undefined ||
      input.allowedFacilityIds !== undefined ||
      input.allowedUnitIds !== undefined;
    if (scopeChanged) {
      const access = existing.customerId
        ? await this.resolveManualScope({
            tenantId: args.tenantId,
            customerId: existing.customerId,
            allFacilities: input.allFacilities ?? false,
            allowedFacilityIds: input.allowedFacilityIds ?? [],
            allowedUnitIds: input.allowedUnitIds ?? [],
            facilityScope: args.facilityScope,
          })
        : {
            // Un acceso temporal nunca abre «todo»: siempre tiene sus locales.
            allowedFacilityIds: input.allowedFacilityIds?.length
              ? input.allowedFacilityIds
              : existing.allowedFacilityIds,
            allowedUnitIds: input.allowedUnitIds ?? existing.allowedUnitIds,
          };
      data.allowedFacilityIds = { set: access.allowedFacilityIds };
      data.allowedUnitIds = { set: access.allowedUnitIds };
    }
    if (input.bypassCurfew !== undefined) data.bypassCurfew = input.bypassCurfew;
    if (input.allowedHours !== undefined)
      data.allowedHours = input.allowedHours as Prisma.InputJsonValue;
    if (input.expiresAt !== undefined)
      data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (input.metadata !== undefined) data.metadata = input.metadata as Prisma.InputJsonValue;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.update({
          where: { id: args.id },
          data,
          include: CUSTOMER_SELECT,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_updated', args, args.id);
    await this.sync.syncCredential(args.tenantId, args.id);
    return this.toDto(updated);
  }

  async rotate(args: {
    tenantId: string;
    userId: string | null;
    id: string;
    input: RotateCredentialInput;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<AccessCredentialWithSecretDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    if (existing.status === ('revoked' as AccessCredentialStatus)) {
      throw new ConflictException({
        code: 'credential_revoked',
        message: 'No se puede rotar una credencial revocada',
      });
    }
    const data: Prisma.AccessCredentialUncheckedUpdateInput = {};
    let revealedSecret: string | null = null;

    if (existing.method === ('pin' as AccessMethod)) {
      const pin = await this.resolveUniquePin(args.tenantId, args.input.pin);
      data.secretHash = await argonHash(pin);
      data.secretPreview = pin.slice(-4);
      data.secretEncrypted = this.crypto.encryptString(pin, args.tenantId);
      revealedSecret = pin;
    } else if (existing.method === ('qr' as AccessMethod)) {
      const token = await this.resolveUniqueQrToken(args.tenantId);
      data.secretHash = await argonHash(token);
      data.secretPreview = token.slice(0, 4);
      data.secretEncrypted = this.crypto.encryptString(token, args.tenantId);
      revealedSecret = token;
    } else {
      // rfid
      if (!args.input.rfidUid) {
        throw new ConflictException({
          code: 'rfid_uid_required',
          message: 'rfidUid requerido para rotar credencial rfid',
        });
      }
      await this.assertRfidFree(args.tenantId, args.input.rfidUid, args.id);
      data.rfidUid = args.input.rfidUid;
      revealedSecret = null;
    }

    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.update({
          where: { id: args.id },
          data,
          include: CUSTOMER_SELECT,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_rotated', args, args.id);
    await this.sync.syncCredential(args.tenantId, args.id);
    return { ...this.toDto(updated), revealedSecret };
  }

  async suspend(args: {
    tenantId: string;
    userId: string | null;
    id?: string;
    customerId?: string;
    input: SuspendCredentialInput;
    meta: RequestMeta;
    /**
     * Solo se aplica cuando se suspende por `id` (path HTTP del staff). El
     * path por `customerId` lo usan integraciones internas (dunning) sin
     * contexto de usuario, así que nunca llega con `facilityScope`.
     */
    facilityScope?: string[] | null;
  }): Promise<AccessCredentialDto[]> {
    if (!args.id && !args.customerId) {
      throw new ConflictException({
        code: 'suspend_target_required',
        message: 'Debes indicar id o customerId',
      });
    }
    if (args.id) {
      await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    }
    const where: Prisma.AccessCredentialWhereInput = {
      status: 'active' as AccessCredentialStatus,
    };
    if (args.id) where.id = args.id;
    if (args.customerId) where.customerId = args.customerId;

    const now = new Date();
    const rows = await this.prisma.withTenant(async (tx) => {
      const result = await tx.accessCredential.updateMany({
        where,
        data: {
          status: 'suspended' as AccessCredentialStatus,
          suspendedAt: now,
          suspendReason: args.input.reason,
        },
      });
      if (result.count === 0) return [];
      const target: Prisma.AccessCredentialWhereInput = {
        status: 'suspended' as AccessCredentialStatus,
      };
      if (args.id) target.id = args.id;
      if (args.customerId) target.customerId = args.customerId;
      return tx.accessCredential.findMany({
        where: target,
        include: CUSTOMER_SELECT,
      });
    }, args.tenantId);

    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'No se encontraron credenciales para suspender',
      });
    }
    for (const r of rows) {
      await this.writeAudit('access.credential_suspended', args, r.id);
      await this.sync.applyState(args.tenantId, r.id, 'suspended');
    }
    return rows.map((r) => this.toDto(r));
  }

  async resume(args: {
    tenantId: string;
    userId: string | null;
    id?: string;
    customerId?: string;
    /**
     * Si se indica, SOLO reactiva las credenciales cuyo `suspendReason` empieza
     * por este prefijo (p. ej. `dunning:`). Sin esto, pagar una factura
     * reactivaría también credenciales que el staff suspendió por OTRO motivo
     * (tarjeta perdida, incidencia de seguridad). Cuando se filtra por motivo,
     * el método es **idempotente**: si no hay nada que reactivar devuelve `[]`
     * (no lanza), porque es un path automático (integración de pago/dunning).
     */
    onlyIfReasonStartsWith?: string;
    meta: RequestMeta;
    /** Igual que en `suspend`: solo aplica cuando se reactiva por `id` (path HTTP). */
    facilityScope?: string[] | null;
  }): Promise<AccessCredentialDto[]> {
    if (!args.id && !args.customerId) {
      throw new ConflictException({
        code: 'resume_target_required',
        message: 'Debes indicar id o customerId',
      });
    }
    if (args.id) {
      await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    }
    const reasonPrefix = args.onlyIfReasonStartsWith;
    const filtered = reasonPrefix !== undefined;
    const where: Prisma.AccessCredentialWhereInput = {
      status: 'suspended' as AccessCredentialStatus,
    };
    if (args.id) where.id = args.id;
    if (args.customerId) where.customerId = args.customerId;
    if (reasonPrefix !== undefined) where.suspendReason = { startsWith: reasonPrefix };

    const rows = await this.prisma.withTenant(async (tx) => {
      // IDs concretos a reactivar (los que casan el filtro) — así el `findMany`
      // posterior solo devuelve estos y no otras credenciales ya activas.
      const toResume = await tx.accessCredential.findMany({
        where,
        select: { id: true },
      });
      if (toResume.length === 0) return [];
      const ids = toResume.map((r) => r.id);
      await tx.accessCredential.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'active' as AccessCredentialStatus,
          suspendedAt: null,
          suspendReason: null,
        },
      });
      return tx.accessCredential.findMany({
        where: { id: { in: ids } },
        include: CUSTOMER_SELECT,
      });
    }, args.tenantId);

    if (rows.length === 0) {
      // Con filtro por motivo (path automático) es idempotente: no hay nada
      // suspendido por ese motivo → no es un error.
      if (filtered) return [];
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'No se encontraron credenciales suspendidas',
      });
    }
    for (const r of rows) {
      await this.writeAudit('access.credential_resumed', args, r.id);
      await this.sync.applyState(args.tenantId, r.id, 'active');
    }
    return rows.map((r) => this.toDto(r));
  }

  async revoke(args: {
    tenantId: string;
    userId: string | null;
    id: string;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<AccessCredentialDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id, args.facilityScope);
    if (existing.status === ('revoked' as AccessCredentialStatus)) {
      throw new ConflictException({
        code: 'credential_already_revoked',
        message: 'La credencial ya esta revocada',
      });
    }
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.update({
          where: { id: args.id },
          data: {
            status: 'revoked' as AccessCredentialStatus,
            revokedAt: new Date(),
            facePhotoKey: null,
          },
          include: CUSTOMER_SELECT,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_revoked', args, args.id);
    await this.sync.applyState(args.tenantId, args.id, 'revoked');
    // La foto de una cara ya no hace falta: es un dato biométrico.
    if (existing.facePhotoKey) {
      await this.files.deleteObjects('uploads', [existing.facePhotoKey]).catch(() => undefined);
    }
    return this.toDto(updated);
  }

  /**
   * Revoca todo lo que abre algo a nombre del inquilino: PIN, QR, tarjetas y
   * caras, activas o suspendidas. Es lo que pasa al irse del todo.
   */
  async revokeAllForCustomer(tenantId: string, customerId: string): Promise<number> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: {
            customerId,
            status: { in: ['active', 'suspended', 'pending'] as AccessCredentialStatus[] },
          },
          select: { id: true },
        }),
      tenantId,
    );
    for (const row of rows) {
      await this.revoke({ tenantId, userId: null, id: row.id, meta: {} });
    }
    return rows.length;
  }

  /** Todo el acceso de un inquilino, para atenderle desde su ficha. */
  async customerSummary(
    tenantId: string,
    customerId: string,
    facilityScope: string[] | null,
  ): Promise<CustomerAccessSummaryDto> {
    await this.assertCustomerInScope(tenantId, customerId, facilityScope);
    const credentials = await this.list(tenantId, { customerId });
    return this.prisma.withTenant(async (tx) => {
      const [actions, lastAllowed, lastDenied, recent] = await Promise.all([
        tx.dunningAction.findMany({
          where: {
            actionType: 'access_block',
            status: 'executed',
            supersededAt: null,
            invoice: { customerId, status: { in: ['issued', 'overdue'] }, deletedAt: null },
          },
          select: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                total: true,
                amountPaid: true,
                amountRefunded: true,
              },
            },
          },
        }),
        tx.accessLog.findFirst({
          where: { customerId, result: 'allowed' },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
        tx.accessLog.findFirst({
          where: { customerId, result: { not: 'allowed' } },
          orderBy: { occurredAt: 'desc' },
          select: { occurredAt: true },
        }),
        tx.accessLog.findMany({
          where: { customerId },
          orderBy: { occurredAt: 'desc' },
          take: 10,
          include: { device: { select: { name: true } } },
        }),
      ]);
      const cutByCredential = credentials.some(
        (c) => c.status === 'suspended' && c.suspendReason?.startsWith('dunning:'),
      );
      return {
        credentials,
        cutForDebt: cutByCredential || actions.length > 0,
        debtInvoices: actions.map(({ invoice: i }) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber,
          amountPending: Number(i.total) - Number(i.amountPaid) + Number(i.amountRefunded),
        })),
        lastAllowedAt: lastAllowed?.occurredAt.toISOString() ?? null,
        lastDeniedAt: lastDenied?.occurredAt.toISOString() ?? null,
        recent: recent.map((l) => ({
          id: l.id,
          deviceId: l.deviceId,
          deviceName: l.device?.name ?? null,
          credentialId: l.credentialId,
          customerId: l.customerId,
          customerName: null,
          method: l.method as AccessMethodValue,
          result: l.result as AccessLogDto['result'],
          attemptedValue: null,
          reason: l.reason,
          ipAddress: null,
          metadata: {},
          occurredAt: l.occurredAt.toISOString(),
          staffName: null,
        })),
      };
    }, tenantId);
  }

  async suspendAllForCustomer(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    reason: string;
    facilityScope: string[] | null;
    meta: RequestMeta;
  }): Promise<{ changed: number }> {
    await this.assertCustomerInScope(args.tenantId, args.customerId, args.facilityScope);
    const rows = await this.suspend({
      tenantId: args.tenantId,
      userId: args.userId,
      customerId: args.customerId,
      input: { reason: args.reason },
      meta: args.meta,
    });
    return { changed: rows.length };
  }

  /** Con la política «solo los adicionales», el acceso principal sigue abriendo. */
  async suspendExtras(tenantId: string, customerId: string, reason: string): Promise<void> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: {
            customerId,
            status: 'active' as AccessCredentialStatus,
            OR: EXTRA_SOURCES.map((source) => ({
              metadata: { path: ['source'], equals: source },
            })),
          },
          select: { id: true },
        }),
      tenantId,
    );
    for (const row of rows) {
      await this.suspend({ tenantId, userId: null, id: row.id, input: { reason }, meta: {} });
    }
  }

  async assertCustomerAllowed(
    tenantId: string,
    customerId: string,
    facilityScope: string[] | null,
  ): Promise<void> {
    await this.assertCustomerInScope(tenantId, customerId, facilityScope);
  }

  /** Lo que el equipo reactiva a mano, también lo cortado por impago. */
  async resumeAllForCustomer(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    facilityScope: string[] | null;
    meta: RequestMeta;
  }): Promise<{ changed: number }> {
    await this.assertCustomerInScope(args.tenantId, args.customerId, args.facilityScope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: {
            customerId: args.customerId,
            status: 'suspended' as AccessCredentialStatus,
          },
          select: { id: true },
        }),
      args.tenantId,
    );
    for (const row of rows) {
      await this.resume({
        tenantId: args.tenantId,
        userId: args.userId,
        id: row.id,
        meta: args.meta,
      });
    }
    return { changed: rows.length };
  }

  /** Accesos temporales de proveedores y equipo. */
  async listTemporary(
    tenantId: string,
    facilityScope: string[] | null,
    facilityId?: string,
  ): Promise<AccessCredentialDto[]> {
    const facilities = resolveFacilityFilter(facilityScope, facilityId);
    if (facilities === null) return [];
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: {
            customerId: null,
            ...(facilities ? { allowedFacilityIds: { hasSome: facilities } } : {}),
          },
          include: CUSTOMER_SELECT,
          orderBy: [{ status: 'asc' }, { expiresAt: 'desc' }],
          take: MAX_TEMPORARY_LIST,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async createTemporary(args: {
    tenantId: string;
    userId: string;
    input: CreateTemporaryAccessInput;
    facilityScope: string[] | null;
    meta: RequestMeta;
  }): Promise<AccessCredentialWithSecretDto> {
    const { input } = args;
    for (const id of input.allowedFacilityIds) assertFacilityAllowed(args.facilityScope, id);
    let secret: Pick<
      Prisma.AccessCredentialUncheckedCreateInput,
      'secretHash' | 'secretPreview' | 'secretEncrypted' | 'rfidUid'
    >;
    let revealedSecret: string | null = null;
    if (input.method === 'pin') {
      const pin = await this.resolveUniquePin(args.tenantId, input.pin);
      revealedSecret = pin;
      secret = {
        secretHash: await argonHash(pin),
        secretPreview: pin.slice(-4),
        secretEncrypted: this.crypto.encryptString(pin, args.tenantId),
      };
    } else {
      await this.assertRfidFree(args.tenantId, input.rfidUid as string);
      secret = { rfidUid: input.rfidUid as string };
    }
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.create({
          data: {
            tenantId: args.tenantId,
            customerId: null,
            holderName: input.holderName,
            holderKind: input.holderKind,
            method: input.method as AccessMethod,
            status: 'active' as AccessCredentialStatus,
            ...secret,
            allowedFacilityIds: input.allowedFacilityIds,
            allowedUnitIds: input.allowedUnitIds,
            allowedHours: input.allowedHours as Prisma.InputJsonValue,
            bypassCurfew: input.bypassCurfew,
            validFrom: input.validFrom ? new Date(input.validFrom) : null,
            expiresAt: new Date(input.expiresAt),
            activatedAt: new Date(),
            metadata: { source: 'temporary' },
          },
          include: CUSTOMER_SELECT,
        }),
      args.tenantId,
    );
    await this.writeAudit('access.credential_created', args, created.id);
    await this.sync.syncCredential(args.tenantId, created.id);
    return { ...this.toDto(created), revealedSecret };
  }

  /**
   * Repaso periódico: marca lo caducado o gastado (y lo saca de los terminales)
   * y revoca lo que le quede a quien ya no tiene ningún contrato.
   */
  async sweep(now = new Date()): Promise<{ expired: number; revoked: number }> {
    const due = await this.admin.accessCredential.findMany({
      where: {
        OR: [
          { status: 'active' as AccessCredentialStatus, expiresAt: { lte: now } },
          { status: 'expired' as AccessCredentialStatus, syncEntries: { some: {} } },
        ],
      },
      select: { id: true, tenantId: true, status: true },
      take: 2000,
    });
    for (const c of due) {
      if (c.status === 'active') {
        await this.admin.accessCredential.updateMany({
          where: { id: c.id, status: 'active' as AccessCredentialStatus },
          data: { status: 'expired' as AccessCredentialStatus },
        });
      }
      await this.sync.applyState(c.tenantId, c.id, 'revoked');
    }

    // Quien tuvo contrato y ya no tiene ninguno. Sin contrato nunca (equipo,
    // proveedores) no se toca: no se ha ido de ningún sitio.
    const gone = await this.admin.customer.findMany({
      where: {
        credentials: {
          some: {
            status: { in: ['active', 'suspended', 'pending'] as AccessCredentialStatus[] },
          },
        },
        contracts: {
          some: { status: { in: ['ended', 'cancelled'] } },
          none: { status: { in: ['draft', 'active', 'ending'] }, deletedAt: null },
        },
      },
      select: { id: true, tenantId: true },
      take: 500,
    });
    let revoked = 0;
    for (const c of gone) revoked += await this.revokeAllForCustomer(c.tenantId, c.id);
    return { expired: due.length, revoked };
  }

  // ===================== portal del inquilino =============================

  /**
   * Credenciales pin/qr ACTIVAS del inquilino, con el valor descifrado para
   * que pueda mostrarlas/presentarlas en el lector. RFID excluido (es física).
   */
  async listForCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<PortalAccessCredentialDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: {
            customerId,
            status: 'active' as AccessCredentialStatus,
            method: { in: ['pin', 'qr'] as AccessMethod[] },
          },
          orderBy: { createdAt: 'desc' },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      method: r.method as 'pin' | 'qr',
      label: r.label,
      status: r.status,
      value: r.secretEncrypted ? this.crypto.decryptString(r.secretEncrypted, tenantId) : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    }));
  }

  /**
   * Accesos del inquilino para su portal: los activos con su código y los
   * suspendidos con el motivo (si es un impago, la factura y lo pendiente),
   * para que sepa por qué no entra y cómo recuperarlo.
   */
  async listForPortal(tenantId: string, customerId: string): Promise<PortalAccessCredentialDto[]> {
    return this.prisma.withTenant(async (tx) => {
      const rows = await tx.accessCredential.findMany({
        where: {
          customerId,
          status: { in: ['active', 'suspended'] as AccessCredentialStatus[] },
          method: { in: ['pin', 'qr'] as AccessMethod[] },
          // Un pase caducado sin usar no se marca solo: no se enseña.
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: 'desc' },
      });
      const live = rows.filter((r) => r.maxUses == null || r.usesCount < r.maxUses);
      const invoiceIds = live
        .map((r) => /^dunning:invoice-([0-9a-f-]{36})$/.exec(r.suspendReason ?? '')?.[1])
        .filter((id): id is string => !!id);
      const invoices = invoiceIds.length
        ? await tx.invoice.findMany({
            where: { id: { in: invoiceIds } },
            select: { id: true, invoiceNumber: true, total: true, amountPaid: true, status: true },
          })
        : [];
      const byId = new Map(invoices.map((i) => [i.id, i]));
      return live.map((r) => {
        const suspended = r.status === 'suspended';
        const invoiceId =
          /^dunning:invoice-([0-9a-f-]{36})$/.exec(r.suspendReason ?? '')?.[1] ?? null;
        const inv = invoiceId ? byId.get(invoiceId) : undefined;
        return {
          id: r.id,
          method: r.method as 'pin' | 'qr',
          label: r.label,
          status: r.status,
          // Un acceso suspendido no abre: no se enseña el código.
          value:
            !suspended && r.secretEncrypted
              ? this.crypto.decryptString(r.secretEncrypted, tenantId)
              : null,
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
          extra: (r.metadata as { source?: string } | null)?.source === 'portal_self_service',
          suspension: suspended
            ? {
                unpaid: !!invoiceId,
                invoiceId: inv?.id ?? null,
                invoiceNumber: inv?.invoiceNumber ?? null,
                pending:
                  inv && ['issued', 'overdue'].includes(inv.status)
                    ? Math.round(Math.max(0, Number(inv.total) - Number(inv.amountPaid)) * 100) /
                      100
                    : null,
              }
            : null,
        };
      });
    }, tenantId);
  }

  /**
   * Historial de accesos del inquilino (sus entradas, para transparencia y
   * seguridad). Devuelve un DTO slim: NO expone valores intentados ni IPs.
   */
  async listLogsForCustomer(tenantId: string, customerId: string): Promise<PortalAccessLogDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessLog.findMany({
          where: { customerId },
          orderBy: { occurredAt: 'desc' },
          take: 50,
          include: { device: { select: { name: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      deviceName: r.device?.name ?? null,
      method: r.method as PortalAccessLogDto['method'],
      result: r.result as PortalAccessLogDto['result'],
      occurredAt: r.occurredAt.toISOString(),
    }));
  }

  /**
   * El inquilino regenera el secreto de SU credencial (p. ej. si lo cree
   * comprometido, o para obtener un valor visible en una credencial antigua).
   * Verifica la propiedad por `customerId` antes de rotar.
   */
  async regenerateForCustomer(
    tenantId: string,
    customerId: string,
    credentialId: string,
  ): Promise<PortalAccessCredentialDto> {
    const existing = await this.prisma.withTenant(
      (tx) => tx.accessCredential.findFirst({ where: { id: credentialId, customerId } }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'Credencial no encontrada',
      });
    }
    if (existing.status !== ('active' as AccessCredentialStatus)) {
      throw new ConflictException({
        code: 'credential_not_active',
        message: 'Solo se puede regenerar una credencial activa',
      });
    }
    if (existing.method !== ('pin' as AccessMethod) && existing.method !== ('qr' as AccessMethod)) {
      throw new ConflictException({
        code: 'credential_not_regenerable',
        message: 'Solo PIN o QR son regenerables desde el portal',
      });
    }

    const data: Prisma.AccessCredentialUncheckedUpdateInput = {};
    if (existing.method === ('pin' as AccessMethod)) {
      const pin = await this.resolveUniquePin(tenantId, undefined);
      data.secretHash = await argonHash(pin);
      data.secretPreview = pin.slice(-4);
      data.secretEncrypted = this.crypto.encryptString(pin, tenantId);
    } else {
      const token = await this.resolveUniqueQrToken(tenantId);
      data.secretHash = await argonHash(token);
      data.secretPreview = token.slice(0, 4);
      data.secretEncrypted = this.crypto.encryptString(token, tenantId);
    }
    const updated = await this.prisma.withTenant(
      (tx) => tx.accessCredential.update({ where: { id: credentialId }, data }),
      tenantId,
    );
    await this.sync.syncCredential(tenantId, credentialId);
    return {
      id: updated.id,
      method: updated.method as 'pin' | 'qr',
      label: updated.label,
      status: updated.status,
      value: updated.secretEncrypted
        ? this.crypto.decryptString(updated.secretEncrypted, tenantId)
        : null,
      expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
      lastUsedAt: updated.lastUsedAt ? updated.lastUsedAt.toISOString() : null,
    };
  }

  /**
   * Locales/trasteros de los contratos vivos del inquilino — el alcance físico
   * al que debe limitarse una credencial emitida para él (sin esto, un array
   * vacío = acceso a TODO el tenant).
   */
  private async customerScope(
    tenantId: string,
    customerId: string,
    facilityId?: string,
  ): Promise<{ allowedFacilityIds: string[]; allowedUnitIds: string[] }> {
    const contracts = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findMany({
          where: {
            customerId,
            status: { in: ['active', 'ending'] },
            deletedAt: null,
            ...STARTED_CONTRACT_WHERE,
            ...(facilityId ? { unit: { facilityId } } : {}),
          },
          select: { unitId: true, unit: { select: { facilityId: true } } },
        }),
      tenantId,
    );
    return {
      allowedFacilityIds: [
        ...new Set(contracts.map((c) => c.unit?.facilityId).filter((x): x is string => !!x)),
      ],
      allowedUnitIds: [...new Set(contracts.map((c) => c.unitId).filter((x): x is string => !!x))],
    };
  }

  /**
   * Alcance de un acceso que pide el propio inquilino. Sin contratos en marcha
   * el alcance saldría vacío, y un alcance vacío abre todos los locales: se
   * rechaza (ex-inquilino con la sesión aún viva, reserva antes de la apertura).
   */
  private async requireCustomerScope(
    tenantId: string,
    customerId: string,
    facilityId?: string,
  ): Promise<{ allowedFacilityIds: string[]; allowedUnitIds: string[] }> {
    const scope = await this.customerScope(tenantId, customerId, facilityId);
    if (scope.allowedFacilityIds.length === 0) {
      throw new ConflictException({
        code: 'no_active_contract',
        message: 'Necesitas un trastero en uso para crear accesos',
      });
    }
    return scope;
  }

  /**
   * El inquilino se crea un **acceso adicional** (p. ej. para un familiar)
   * desde el portal, hasta el máximo configurado por el tenant
   * (`tenants.extra_access_limit`). Solo PIN (con etiqueta).
   */
  async createExtraForCustomer(
    tenantId: string,
    customerId: string,
    label: string,
  ): Promise<PortalAccessCredentialDto> {
    await this.assertNotCutForDebt(tenantId, customerId);
    const limit = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { extraAccessLimit: true } }),
      tenantId,
    );
    const max = limit?.extraAccessLimit ?? 2;
    const used = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.count({
          where: {
            customerId,
            status: { in: ['active', 'suspended'] as AccessCredentialStatus[] },
            metadata: { path: ['source'], equals: 'portal_self_service' },
          },
        }),
      tenantId,
    );
    if (used >= max) {
      throw new ConflictException({
        code: 'extra_access_limit_reached',
        message: `Has alcanzado el máximo de accesos adicionales (${max})`,
      });
    }
    const scope = await this.requireCustomerScope(tenantId, customerId);
    const created = await this.create({
      tenantId,
      userId: null,
      input: {
        customerId,
        method: 'pin',
        label: label.trim() || 'Acceso adicional',
        allowedFacilityIds: scope.allowedFacilityIds,
        allowedUnitIds: scope.allowedUnitIds,
        allowedHours: { windows: [] },
        bypassCurfew: false,
        metadata: { source: 'portal_self_service' },
      } as CreateCredentialInput,
      meta: {},
    });
    return {
      id: created.id,
      method: 'pin',
      label: created.label,
      status: created.status,
      value: created.revealedSecret,
      expiresAt: created.expiresAt,
      lastUsedAt: null,
    };
  }

  /**
   * Pase de visita que crea el propio inquilino (mudanza, un familiar, un
   * transportista): PIN de un solo uso, válido hasta el final del día en la
   * hora del local y solo en ese local. Como mucho `VISITOR_PASSES_PER_DAY`
   * al día.
   */
  async createVisitorPassForCustomer(
    tenantId: string,
    customerId: string,
    args: { label: string; facilityId?: string | undefined; authorizedPersonId?: string | null },
  ): Promise<PortalAccessCredentialDto & { facilityId: string }> {
    await this.assertNotCutForDebt(tenantId, customerId);
    const all = await this.requireCustomerScope(tenantId, customerId);
    let facilityId = args.facilityId;
    if (facilityId && !all.allowedFacilityIds.includes(facilityId)) {
      throw new BadRequestException({
        code: 'facility_not_allowed',
        message: 'Solo puedes crear pases para un local donde tengas trastero',
      });
    }
    if (!facilityId) {
      if (all.allowedFacilityIds.length > 1) {
        throw new BadRequestException({
          code: 'facility_required',
          message: 'Elige el local de la visita',
        });
      }
      facilityId = all.allowedFacilityIds[0]!;
    }
    const facility = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({
          where: { id: facilityId, deletedAt: null },
          select: { timezone: true },
        }),
      tenantId,
    );
    const tz = facility?.timezone ?? 'Europe/Madrid';
    const today = todayInTimezone(tz).toISOString().slice(0, 10);
    const dayStart = zonedDayStart(today, tz);
    const used = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.count({
          where: {
            customerId,
            createdAt: { gte: dayStart },
            metadata: { path: ['source'], equals: 'portal_visitor' },
          },
        }),
      tenantId,
    );
    if (used >= VISITOR_PASSES_PER_DAY) {
      throw new ConflictException({
        code: 'visitor_pass_limit_reached',
        message: `Puedes crear como mucho ${VISITOR_PASSES_PER_DAY} pases de visita al día`,
      });
    }
    const scope = await this.requireCustomerScope(tenantId, customerId, facilityId);
    const created = await this.create({
      tenantId,
      userId: null,
      input: {
        customerId,
        method: 'pin',
        label: `Visita: ${args.label.trim()}`.slice(0, 120),
        allowedFacilityIds: scope.allowedFacilityIds,
        allowedUnitIds: scope.allowedUnitIds,
        allowedHours: { windows: [] },
        bypassCurfew: false,
        maxUses: 1,
        expiresAt: zonedNextDayStart(today, tz).toISOString(),
        metadata: {
          source: 'portal_visitor',
          facilityId,
          ...(args.authorizedPersonId ? { authorizedPersonId: args.authorizedPersonId } : {}),
        },
      } as CreateCredentialInput,
      meta: {},
    });
    return {
      id: created.id,
      method: 'pin',
      label: created.label,
      status: created.status,
      value: created.revealedSecret,
      expiresAt: created.expiresAt,
      lastUsedAt: null,
      facilityId,
    };
  }

  /**
   * Pase nocturno: PIN de **un solo uso** que **salta el toque de queda** y
   * caduca a la mañana siguiente (08:00 Europe/Madrid). El cobro lo orquesta
   * quien llama (NightPassService) — esto solo emite el código.
   */
  /**
   * Pase nocturno: con `facilityId` el PIN solo abre ese local (y los trasteros
   * del inquilino en él); sin él, todos sus locales con contrato vivo.
   */
  async createNightPassForCustomer(
    tenantId: string,
    customerId: string,
    facilityId?: string,
  ): Promise<PortalAccessCredentialDto> {
    await this.assertNotCutForDebt(tenantId, customerId);
    const scope = await this.requireCustomerScope(tenantId, customerId, facilityId);
    const passFacilityId = facilityId ?? (scope.allowedFacilityIds[0] as string);
    const facility = await this.prisma.withTenant(
      (tx) => tx.facility.findFirst({ where: { id: passFacilityId }, select: { timezone: true } }),
      tenantId,
    );
    const created = await this.create({
      tenantId,
      userId: null,
      input: {
        customerId,
        method: 'pin',
        label: 'Pase nocturno',
        allowedFacilityIds: scope.allowedFacilityIds,
        allowedUnitIds: scope.allowedUnitIds,
        allowedHours: { windows: [] },
        bypassCurfew: true,
        maxUses: 1,
        expiresAt: nextMorningIso(facility?.timezone ?? 'Europe/Madrid'),
        metadata: { source: 'night_pass', ...(facilityId ? { facilityId } : {}) },
      } as CreateCredentialInput,
      meta: {},
    });
    return {
      id: created.id,
      method: 'pin',
      label: created.label,
      status: created.status,
      value: created.revealedSecret,
      expiresAt: created.expiresAt,
      lastUsedAt: null,
    };
  }

  /**
   * PIN de un solo uso para alguien que viene en nombre del inquilino (mudanza,
   * familiar), válido hasta el final del día en la hora del local y solo en él.
   */
  async createVisitorPin(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    facilityId: string;
    label?: string;
    facilityScope?: string[] | null;
    meta: RequestMeta;
  }): Promise<VisitorPinDto> {
    const facility = await this.prisma.withTenant(
      (tx) =>
        tx.facility.findFirst({
          where: { id: args.facilityId, deletedAt: null },
          select: { id: true, timezone: true },
        }),
      args.tenantId,
    );
    if (!facility) {
      throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
    }
    const today = todayInTimezone(facility.timezone).toISOString().slice(0, 10);
    const expiresAt = zonedNextDayStart(today, facility.timezone).toISOString();
    const scope = await this.customerScope(args.tenantId, args.customerId, args.facilityId);
    const customerCutForDebt = await this.isCutForDebt(args.tenantId, args.customerId);
    const created = await this.create({
      tenantId: args.tenantId,
      userId: args.userId,
      facilityScope: args.facilityScope ?? null,
      input: {
        customerId: args.customerId,
        method: 'pin',
        label: args.label?.trim() || 'Visita',
        allowedFacilityIds: scope.allowedFacilityIds.length
          ? scope.allowedFacilityIds
          : [args.facilityId],
        allowedUnitIds: scope.allowedUnitIds,
        allowedHours: { windows: [] },
        bypassCurfew: false,
        maxUses: 1,
        expiresAt,
        metadata: { source: 'visitor', facilityId: args.facilityId },
      } as CreateCredentialInput,
      meta: args.meta,
    });
    return {
      credentialId: created.id,
      pin: created.revealedSecret ?? '',
      expiresAt,
      customerCutForDebt,
    };
  }

  private async findOrThrow(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<CredentialWithCustomer> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findFirst({
          where: { id },
          include: CUSTOMER_SELECT,
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'credential_not_found',
        message: 'Credencial no encontrada',
      });
    }
    if (row.customerId) {
      await this.assertCustomerInScope(tenantId, row.customerId, facilityScope);
    } else {
      for (const id of row.allowedFacilityIds) assertFacilityAllowed(facilityScope, id);
    }
    return row as CredentialWithCustomer;
  }

  /**
   * Rehace el alcance de las credenciales del inquilino con sus contratos vivos
   * (tras un traslado de trastero). Solo toca las que ya estaban acotadas a sus
   * trasteros o locales (las emitidas solas al firmar/pagar); una sin alcance
   * (abre todo) o un pase nocturno de un local concreto se quedan como estaban.
   */
  async rescopeForCustomer(tenantId: string, customerId: string): Promise<number> {
    const scope = await this.customerScope(tenantId, customerId);
    if (scope.allowedFacilityIds.length === 0) return 0;
    const creds = await this.prisma.withTenant(
      (tx) =>
        tx.accessCredential.findMany({
          where: { customerId, status: { in: ['active', 'suspended', 'pending'] } },
          select: { id: true, allowedFacilityIds: true, allowedUnitIds: true, metadata: true },
        }),
      tenantId,
    );
    let changed = 0;
    for (const c of creds) {
      const source = (c.metadata as { source?: string } | null)?.source;
      if (source === 'night_pass') continue;
      if (c.allowedFacilityIds.length === 0 && c.allowedUnitIds.length === 0) continue;
      const sameFacilities =
        [...c.allowedFacilityIds].sort().join() === [...scope.allowedFacilityIds].sort().join();
      const sameUnits =
        [...c.allowedUnitIds].sort().join() === [...scope.allowedUnitIds].sort().join();
      if (sameFacilities && sameUnits) continue;
      await this.prisma.withTenant(
        (tx) =>
          tx.accessCredential.update({
            where: { id: c.id },
            data: {
              allowedFacilityIds: scope.allowedFacilityIds,
              // Una credencial de local (sin trasteros) sigue siéndolo.
              allowedUnitIds: c.allowedUnitIds.length > 0 ? scope.allowedUnitIds : [],
            },
          }),
        tenantId,
      );
      await this.sync.syncCredential(tenantId, c.id).catch(() => undefined);
      changed += 1;
    }
    return changed;
  }

  /**
   * ¿El staff (con `facilityScope`) puede gestionar credenciales de este
   * cliente? Una credencial no tiene un `facilityId` propio (puede abarcar
   * varios locales vía `allowedFacilityIds`, que además suele venir VACÍO =
   * sin restricción física, ver `checkFacility` en access-verify) → el scope
   * se resuelve por los locales de los CONTRATOS del cliente, el mismo
   * criterio que ya usa `customerScope` al emitir credenciales automáticas.
   */
  private async assertCustomerInScope(
    tenantId: string,
    customerId: string,
    facilityScope: string[] | null | undefined,
  ): Promise<void> {
    if (!facilityScope) return;
    const contract = await this.prisma.withTenant(
      (tx) =>
        tx.contract.findFirst({
          where: { customerId, unit: { facilityId: { in: facilityScope } } },
          select: { id: true },
        }),
      tenantId,
    );
    if (!contract) {
      throw new ForbiddenException({
        code: 'facility_not_in_scope',
        message: 'No tienes acceso a ese local',
      });
    }
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string | null; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'AccessCredential',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(c: CredentialWithCustomer): AccessCredentialDto {
    return {
      id: c.id,
      customerId: c.customerId,
      customerName: c.holderName ?? customerDisplay(c.customer),
      holderKind: c.holderKind,
      validFrom: c.validFrom?.toISOString() ?? null,
      method: c.method as AccessMethodValue,
      // Lo caducado se enseña como tal aunque el repaso aún no haya pasado.
      status: (c.status === 'active' && c.expiresAt && c.expiresAt <= new Date()
        ? 'expired'
        : c.status) as AccessCredentialStatusValue,
      label: c.label,
      // En un PIN, dos cifras bastan para reconocerlo y no ayudan a adivinarlo.
      secretPreview:
        c.method === 'pin' && c.secretPreview
          ? `••••${c.secretPreview.slice(-2)}`
          : c.secretPreview,
      rfidUid: c.rfidUid,
      allowedFacilityIds: c.allowedFacilityIds,
      allowedUnitIds: c.allowedUnitIds,
      allowedHours: { windows: accessWindowsFrom(c.allowedHours) },
      bypassCurfew: c.bypassCurfew,
      maxUses: c.maxUses,
      usesCount: c.usesCount,
      suspendReason: c.suspendReason,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      activatedAt: c.activatedAt?.toISOString() ?? null,
      suspendedAt: c.suspendedAt?.toISOString() ?? null,
      revokedAt: c.revokedAt?.toISOString() ?? null,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      contractId: c.contractId,
      metadata: (c.metadata ?? {}) as Record<string, unknown>,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
