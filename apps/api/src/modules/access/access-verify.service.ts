import { Inject, Injectable, Logger } from '@nestjs/common';
import { verify as argonVerify } from '@node-rs/argon2';
import { accessWindowsFrom, isWithinAccessWindows } from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { AccessRateLimitService } from './access-rate-limit.service';
import { LOCK_PROVIDER, type LockProvider } from './providers/lock-provider';

import type {
  AccessCredential,
  AccessCredentialStatus,
  AccessDevice,
  AccessMethod,
  AccessResult,
  Customer,
  CustomerType,
  Prisma,
} from '@storageos/database';
import type {
  AccessMethodValue,
  AccessResultValue,
  PortalDoorDto,
  PortalOpenDoorResultDto,
  VerifyAccessResultDto,
} from '@storageos/shared';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Minutos desde medianoche "ahora" en una zona horaria dada. */
function nowMinutesInTz(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hh * 60 + mm;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** Día de la semana "ahora" (0=domingo … 6=sábado) en una zona horaria. */
function nowWeekdayInTz(timezone: string): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    new Date(),
  );
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[short] ?? new Date().getDay();
}

/**
 * Ventanas horarias por credencial: si la credencial define franjas
 * (`allowedHours.windows`) y "ahora" (en la TZ del local) no cae en ninguna,
 * se deniega. Sin ventanas → sin restricción. Independiente del toque de queda
 * del local (que aplica a todas las credenciales sin `bypassCurfew`).
 */
function checkAccessWindows(
  credential: { allowedHours: unknown },
  facility: { timezone: string } | null,
): { result: AccessResultValue; reason: string } | null {
  const windows = accessWindowsFrom(credential.allowedHours);
  if (windows.length === 0) return null;
  const tz = facility?.timezone ?? 'Europe/Madrid';
  const ok = isWithinAccessWindows(windows, nowWeekdayInTz(tz), nowMinutesInTz(tz));
  return ok
    ? null
    : {
        result: 'denied_outside_hours',
        reason: 'Fuera del horario permitido para esta credencial',
      };
}

/** ¿Es ahora dentro del toque de queda [start, end)? Soporta cruzar medianoche. */
function checkCurfew(
  facility: {
    timezone: string;
    accessCurfewEnabled: boolean;
    accessCurfewStart: string | null;
    accessCurfewEnd: string | null;
  } | null,
  credential: { bypassCurfew: boolean },
): { result: AccessResultValue; reason: string } | null {
  if (!facility?.accessCurfewEnabled || !facility.accessCurfewStart || !facility.accessCurfewEnd) {
    return null;
  }
  if (credential.bypassCurfew) return null; // acceso 24h (staff)
  const now = nowMinutesInTz(facility.timezone);
  const start = hhmmToMinutes(facility.accessCurfewStart);
  const end = hhmmToMinutes(facility.accessCurfewEnd);
  const inWindow =
    start === end ? false : start < end ? now >= start && now < end : now >= start || now < end;
  return inWindow
    ? { result: 'denied_outside_hours', reason: 'Acceso cerrado (toque de queda del local)' }
    : null;
}

interface VerifyArgs {
  tenantId: string;
  device: AccessDevice;
  method: AccessMethodValue;
  credential: string;
  ipAddress?: string | undefined;
}

interface ResolveDeviceArgs {
  /** Hardware ID o UUID. */
  deviceRef: string;
  /** API key en texto plano. */
  apiKey: string;
}

type CredentialWithCustomer = AccessCredential & {
  customer?: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null;
};

function customerDisplay(
  c: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null | undefined,
): string {
  if (!c) return 'Cliente';
  if (c.customerType === ('business' as CustomerType)) return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

function sanitizeAttempted(method: AccessMethodValue, raw: string): string {
  if (method === 'pin') return raw.slice(-4).padStart(raw.length, '*');
  if (method === 'qr') return raw.slice(0, 8);
  return raw; // rfid UID no es secreto
}

/**
 * AccessVerifyService: corazon de la Fase 7.
 *
 *   1. Resuelve device por hardwareId/UUID + valida API key (argon2).
 *   2. Busca credencial activa que matchee el `credential` recibido.
 *   3. Valida estado, expiracion, facility/unit permitidos, horario.
 *   4. Si ok, dispara `LockProvider.open()` y loguea en `access_logs`.
 *   5. Cada intento (exitoso, denegado, error) deja una fila en
 *      `access_logs` via PrismaAdminService (no requiere RLS context).
 */
@Injectable()
export class AccessVerifyService {
  private readonly logger = new Logger(AccessVerifyService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crypto: CryptoService,
    @Inject(LOCK_PROVIDER) private readonly lock: LockProvider,
    private readonly rateLimit: AccessRateLimitService,
  ) {}

  /**
   * Resuelve un device por hardwareId (o UUID) y valida la API key.
   * Devuelve null si no existe o la API key no matchea.
   *
   * NOTA: itera devices con `hardwareId` y verifica argon2 contra el hash.
   * Para Fase 7 esto es aceptable; en Fase 8 puede optimizarse con un
   * cache LRU en memoria o un prefix-index.
   */
  async authenticateDevice(args: ResolveDeviceArgs): Promise<AccessDevice | null> {
    // 1) intentar por UUID
    let device: AccessDevice | null = null;
    if (UUID_REGEX.test(args.deviceRef)) {
      device = await this.admin.accessDevice.findFirst({
        where: { id: args.deviceRef, isActive: true },
      });
    }
    // 2) fallback por hardwareId (puede haber varios tenants distintos)
    if (!device) {
      const candidates = await this.admin.accessDevice.findMany({
        where: { hardwareId: args.deviceRef, isActive: true },
        take: 50,
      });
      for (const candidate of candidates) {
        if (!candidate.apiKeyHash) continue;
        try {
          if (await argonVerify(candidate.apiKeyHash, args.apiKey)) {
            device = candidate;
            break;
          }
        } catch {
          // fallthrough
        }
      }
      if (device) return device;
      return null;
    }
    // device por UUID: verificar API key
    if (!device.apiKeyHash) return null;
    try {
      if (await argonVerify(device.apiKeyHash, args.apiKey)) return device;
    } catch {
      return null;
    }
    return null;
  }

  async verify(args: VerifyArgs): Promise<VerifyAccessResultDto> {
    const { tenantId, device, method, credential, ipAddress } = args;
    const attemptedValue = sanitizeAttempted(method, credential);

    // Anti-fuerza-bruta: si el dispositivo está bloqueado por demasiados PINs
    // fallidos, deniega SIN mirar credenciales (frena el tecleo masivo).
    if (await this.rateLimit.isDeviceLocked(device.id)) {
      await this.log({
        tenantId,
        deviceId: device.id,
        credentialId: null,
        customerId: null,
        method,
        result: 'denied_unknown',
        attemptedValue,
        reason: 'Dispositivo bloqueado temporalmente (demasiados intentos)',
        ipAddress,
      });
      return {
        result: 'denied_unknown',
        allowed: false,
        reason: 'Dispositivo bloqueado temporalmente',
      };
    }

    const credentialRow = await this.findCredential(tenantId, method, credential);
    if (!credentialRow) {
      // PIN/QR no reconocido: cuenta para el lockout del dispositivo.
      await this.rateLimit.recordDeviceFailure(device.id);
      await this.log({
        tenantId,
        deviceId: device.id,
        credentialId: null,
        customerId: null,
        method,
        result: 'denied_invalid_credential',
        attemptedValue,
        reason: 'Credencial no encontrada',
        ipAddress,
      });
      return {
        result: 'denied_invalid_credential',
        allowed: false,
        reason: 'Credencial no valida',
      };
    }

    // Lockout por credencial: si esta credencial concreta está bloqueada (se
    // martilleó fuera de sitio/horario), deniega sin procesar.
    if (await this.rateLimit.isCredentialLocked(credentialRow.id)) {
      await this.log({
        tenantId,
        deviceId: device.id,
        credentialId: credentialRow.id,
        customerId: credentialRow.customerId,
        method,
        result: 'denied_unknown',
        attemptedValue,
        reason: 'Credencial bloqueada temporalmente (demasiados intentos)',
        ipAddress,
      });
      return {
        result: 'denied_unknown',
        allowed: false,
        customerName: customerDisplay(credentialRow.customer),
        reason: 'Credencial bloqueada temporalmente',
      };
    }

    // Toque de queda del local (zona horaria del facility del device).
    const facility = await this.admin.facility.findUnique({
      where: { id: device.facilityId },
      select: {
        timezone: true,
        accessCurfewEnabled: true,
        accessCurfewStart: true,
        accessCurfewEnd: true,
      },
    });
    const denied =
      this.evaluateCredential(credentialRow, device) ??
      checkAccessWindows(credentialRow, facility) ??
      checkCurfew(facility, credentialRow);
    if (denied) {
      // Cuenta para el lockout de la credencial salvo si es una suspensión/
      // revocación (`denied_inactive_credential`): esas son estados legítimos
      // (p. ej. impago) que se limpian al pagar → bloquearlas dejaría fuera a
      // quien acaba de regularizar.
      if (denied.result !== 'denied_inactive_credential') {
        await this.rateLimit.recordCredentialFailure(credentialRow.id);
      }
      await this.log({
        tenantId,
        deviceId: device.id,
        credentialId: credentialRow.id,
        customerId: credentialRow.customerId,
        method,
        result: denied.result,
        attemptedValue,
        reason: denied.reason,
        ipAddress,
      });
      // Si esta expired, mover a estado expired (best-effort).
      if (
        denied.result === 'denied_invalid_credential' &&
        credentialRow.expiresAt &&
        credentialRow.expiresAt.getTime() <= Date.now() &&
        credentialRow.status !== ('expired' as AccessCredentialStatus)
      ) {
        await this.admin.accessCredential
          .update({
            where: { id: credentialRow.id },
            data: { status: 'expired' as AccessCredentialStatus },
          })
          .catch((err) => this.logger.warn(`No se pudo marcar expired: ${String(err)}`));
      }
      return {
        result: denied.result,
        allowed: false,
        customerName: customerDisplay(credentialRow.customer),
        reason: denied.reason,
      };
    }

    // OK (pasó todas las validaciones). Para credenciales single-use (pase
    // nocturno) RESERVA el uso de forma ATÓMICA **antes** de abrir: un
    // `updateMany` condicionado a `usesCount < maxUses` serializa dos verify
    // concurrentes con el mismo PIN → solo el primero incrementa; el segundo ve
    // `count===0` y se deniega (evita que un pase de 1 uso se gaste dos veces).
    if (credentialRow.maxUses != null) {
      const claim = await this.admin.accessCredential.updateMany({
        where: { id: credentialRow.id, usesCount: { lt: credentialRow.maxUses } },
        data: { usesCount: { increment: 1 } },
      });
      if (claim.count === 0) {
        await this.log({
          tenantId,
          deviceId: device.id,
          credentialId: credentialRow.id,
          customerId: credentialRow.customerId,
          method,
          result: 'denied_inactive_credential',
          attemptedValue,
          reason: 'Pase ya utilizado',
          ipAddress,
        });
        return {
          result: 'denied_inactive_credential',
          allowed: false,
          customerName: customerDisplay(credentialRow.customer),
          reason: 'Pase ya utilizado',
        };
      }
    }

    const openResult = await this.lock.open({
      tenantId,
      deviceId: device.id,
      mqttTopic: device.mqttTopic,
      controlUrl: device.controlUrl,
      controlSecret: device.controlSecretEncrypted
        ? this.crypto.decryptString(device.controlSecretEncrypted)
        : null,
      customerId: credentialRow.customerId,
    });

    if (!openResult.dispatched) {
      // La cerradura NO abrió (device offline / timeout). Si era single-use,
      // DEVOLVEMOS el uso reservado: el inquilino no debe perder el pase (que
      // pagó) por un fallo del hardware.
      if (credentialRow.maxUses != null) {
        await this.admin.accessCredential
          .updateMany({
            where: { id: credentialRow.id, usesCount: { gt: 0 } },
            data: { usesCount: { decrement: 1 } },
          })
          .catch((err) => this.logger.warn(`No se pudo devolver el uso del pase: ${String(err)}`));
      }
      await this.log({
        tenantId,
        deviceId: device.id,
        credentialId: credentialRow.id,
        customerId: credentialRow.customerId,
        method,
        result: 'error',
        attemptedValue,
        reason: openResult.message ?? 'Lock dispatch fallido',
        ipAddress,
      });
      return {
        result: 'error',
        allowed: false,
        customerName: customerDisplay(credentialRow.customer),
        reason: openResult.message ?? 'Fallo de dispositivo',
      };
    }

    // Abrió: registra el uso y, si el single-use quedó agotado, márcalo expired.
    const spent =
      credentialRow.maxUses != null && credentialRow.usesCount + 1 >= credentialRow.maxUses;
    await this.admin.accessCredential
      .update({
        where: { id: credentialRow.id },
        data: {
          lastUsedAt: new Date(),
          ...(spent ? { status: 'expired' as AccessCredentialStatus } : {}),
        },
      })
      .catch((err) => this.logger.warn(`No se pudo actualizar lastUsedAt: ${String(err)}`));

    // Acceso permitido → limpia los contadores/bloqueos del device y la credencial.
    await this.rateLimit.reset(device.id, credentialRow.id);

    await this.log({
      tenantId,
      deviceId: device.id,
      credentialId: credentialRow.id,
      customerId: credentialRow.customerId,
      method,
      result: 'allowed',
      attemptedValue,
      reason: null,
      ipAddress,
    });

    return {
      result: 'allowed',
      allowed: true,
      customerName: customerDisplay(credentialRow.customer),
    };
  }

  // -------------------------------------------------------------------------
  // Apertura desde el PORTAL del inquilino («tu móvil es la llave»). Reusa el
  // pipeline del verify (credencial del cliente + curfew/ventanas/suspensión +
  // LockProvider + access_logs), pero identificado por el customer del token de
  // portal en vez de por un secreto presentado.
  // -------------------------------------------------------------------------

  /** Puertas que el inquilino puede intentar abrir: dispositivos de los locales donde tiene contrato vivo. */
  async listDoorsForCustomer(tenantId: string, customerId: string): Promise<PortalDoorDto[]> {
    const contracts = await this.admin.contract.findMany({
      where: { tenantId, customerId, status: { in: ['active', 'ending'] }, deletedAt: null },
      select: { unit: { select: { facilityId: true } } },
    });
    const facilityIds = [...new Set(contracts.map((c) => c.unit.facilityId))];
    if (facilityIds.length === 0) return [];
    const devices = await this.admin.accessDevice.findMany({
      where: { tenantId, facilityId: { in: facilityIds }, isActive: true },
      select: { id: true, name: true, facility: { select: { name: true } } },
      orderBy: [{ name: 'asc' }],
    });
    return devices.map((d) => ({ id: d.id, name: d.name, facilityName: d.facility.name }));
  }

  /** El inquilino abre una puerta desde el portal (con sus credenciales activas). */
  async openForCustomer(args: {
    tenantId: string;
    customerId: string;
    deviceId: string;
    ipAddress?: string | undefined;
  }): Promise<PortalOpenDoorResultDto> {
    const { tenantId, customerId, deviceId, ipAddress } = args;
    const device = await this.admin.accessDevice.findFirst({
      where: { id: deviceId, tenantId },
    });
    if (!device || !device.isActive) {
      return { opened: false, message: 'Puerta no disponible.' };
    }
    // El inquilino solo puede abrir puertas de los locales donde tiene contrato vivo.
    const hasContract = await this.admin.contract.count({
      where: {
        tenantId,
        customerId,
        status: { in: ['active', 'ending'] },
        deletedAt: null,
        unit: { facilityId: device.facilityId },
      },
    });
    if (hasContract === 0) {
      return { opened: false, message: 'No tienes un contrato en este local.' };
    }
    if (await this.rateLimit.isDeviceLocked(device.id)) {
      return { opened: false, message: 'Demasiados intentos. Prueba en unos minutos.' };
    }
    const facility = await this.admin.facility.findUnique({
      where: { id: device.facilityId },
      select: {
        timezone: true,
        accessCurfewEnabled: true,
        accessCurfewStart: true,
        accessCurfewEnd: true,
      },
    });

    const creds = (await this.admin.accessCredential.findMany({
      where: {
        tenantId,
        customerId,
        status: 'active' as AccessCredentialStatus,
        method: { in: ['pin', 'qr'] as AccessMethod[] },
      },
      include: {
        customer: {
          select: { customerType: true, firstName: true, lastName: true, companyName: true },
        },
      },
    })) as CredentialWithCustomer[];

    if (creds.length === 0) {
      await this.log({
        tenantId,
        deviceId: device.id,
        credentialId: null,
        customerId,
        method: 'pin',
        result: 'denied_inactive_credential',
        attemptedValue: null,
        reason: 'portal: sin credencial activa',
        ipAddress,
      });
      return {
        opened: false,
        message:
          'No tienes acceso activo. Si tienes un pago pendiente, tu acceso puede estar suspendido.',
      };
    }

    // Elige la 1ª credencial que pase TODAS las validaciones; prefiere las que NO
    // son de un solo uso (para no gastar un pase nocturno si hay una normal).
    const ordered = [...creds].sort(
      (a, b) => (a.maxUses == null ? 0 : 1) - (b.maxUses == null ? 0 : 1),
    );
    let chosen: CredentialWithCustomer | null = null;
    let lastDenied: { result: AccessResultValue; reason: string } | null = null;
    for (const c of ordered) {
      const denied =
        this.evaluateCredential(c, device) ??
        checkAccessWindows(c, facility) ??
        checkCurfew(facility, c);
      if (!denied) {
        chosen = c;
        break;
      }
      lastDenied = denied;
    }
    if (!chosen) {
      const d = lastDenied ?? {
        result: 'denied_unknown' as AccessResultValue,
        reason: 'No permitido',
      };
      await this.log({
        tenantId,
        deviceId: device.id,
        credentialId: null,
        customerId,
        method: 'pin',
        result: d.result,
        attemptedValue: null,
        reason: `portal: ${d.reason}`,
        ipAddress,
      });
      return { opened: false, message: d.reason };
    }

    // Single-use (pase nocturno): reserva el uso ATÓMICAMENTE antes de abrir.
    if (chosen.maxUses != null) {
      const claim = await this.admin.accessCredential.updateMany({
        where: { id: chosen.id, usesCount: { lt: chosen.maxUses } },
        data: { usesCount: { increment: 1 } },
      });
      if (claim.count === 0) {
        return { opened: false, message: 'Ese pase ya se ha utilizado.' };
      }
    }

    const openResult = await this.lock.open({
      tenantId,
      deviceId: device.id,
      mqttTopic: device.mqttTopic,
      controlUrl: device.controlUrl,
      controlSecret: device.controlSecretEncrypted
        ? this.crypto.decryptString(device.controlSecretEncrypted)
        : null,
      customerId,
    });
    // Si la cerradura NO abrió y era single-use, devuelve el uso reservado.
    if (!openResult.dispatched && chosen.maxUses != null) {
      await this.admin.accessCredential.updateMany({
        where: { id: chosen.id, usesCount: { gt: 0 } },
        data: { usesCount: { decrement: 1 } },
      });
    }
    await this.log({
      tenantId,
      deviceId: device.id,
      credentialId: chosen.id,
      customerId,
      method: chosen.method as AccessMethodValue,
      result: (openResult.dispatched ? 'allowed' : 'error') as AccessResultValue,
      attemptedValue: null,
      reason: openResult.dispatched
        ? 'portal_open_by_customer'
        : (openResult.message ?? 'lock_error'),
      ipAddress,
    });
    if (openResult.dispatched) {
      await this.rateLimit.reset(device.id, chosen.id);
      await this.admin.accessDevice
        .update({ where: { id: device.id }, data: { isOnline: true, lastSeenAt: new Date() } })
        .catch(() => undefined);
      return { opened: true, message: 'Abriendo la puerta…' };
    }
    return {
      opened: false,
      message: 'No se pudo abrir la puerta ahora mismo. Vuelve a intentarlo.',
    };
  }

  /**
   * Busca la credencial que matchea con `credential`. Para PIN/QR itera
   * candidatos del tenant con el mismo `secretPreview` (prefiltro barato)
   * y verifica argon2; para RFID hace un lookup directo por `rfidUid`.
   */
  private async findCredential(
    tenantId: string,
    method: AccessMethodValue,
    credential: string,
  ): Promise<CredentialWithCustomer | null> {
    const include = {
      customer: {
        select: {
          customerType: true,
          firstName: true,
          lastName: true,
          companyName: true,
        },
      },
    } satisfies Prisma.AccessCredentialInclude;

    if (method === 'rfid') {
      const row = await this.admin.accessCredential.findFirst({
        where: { tenantId, method: 'rfid' as AccessMethod, rfidUid: credential },
        include,
      });
      return row as CredentialWithCustomer | null;
    }

    // pin/qr: prefiltrar por secretPreview
    const preview = method === 'pin' ? credential.slice(-4) : credential.slice(0, 4);
    const candidates = await this.admin.accessCredential.findMany({
      where: {
        tenantId,
        method: method as AccessMethod,
        secretPreview: preview,
      },
      include,
      take: 200,
    });
    for (const candidate of candidates) {
      if (!candidate.secretHash) continue;
      try {
        if (await argonVerify(candidate.secretHash, credential)) {
          return candidate as CredentialWithCustomer;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  private evaluateCredential(
    credential: AccessCredential,
    device: AccessDevice,
  ): { result: AccessResultValue; reason: string } | null {
    if (credential.status === ('suspended' as AccessCredentialStatus)) {
      return {
        result: 'denied_inactive_credential',
        reason: 'Credencial suspendida',
      };
    }
    if (
      credential.status === ('revoked' as AccessCredentialStatus) ||
      credential.status === ('expired' as AccessCredentialStatus) ||
      credential.status === ('pending' as AccessCredentialStatus)
    ) {
      return {
        result: 'denied_inactive_credential',
        reason: `Credencial ${credential.status}`,
      };
    }
    if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
      return {
        result: 'denied_invalid_credential',
        reason: 'Credencial expirada',
      };
    }
    // Single-use ya gastado (pase nocturno).
    if (credential.maxUses != null && credential.usesCount >= credential.maxUses) {
      return {
        result: 'denied_inactive_credential',
        reason: 'Pase ya utilizado',
      };
    }
    if (
      credential.allowedFacilityIds.length > 0 &&
      !credential.allowedFacilityIds.includes(device.facilityId)
    ) {
      return {
        result: 'denied_wrong_facility',
        reason: 'Facility no permitida',
      };
    }
    if (
      device.unitId &&
      credential.allowedUnitIds.length > 0 &&
      !credential.allowedUnitIds.includes(device.unitId)
    ) {
      return {
        result: 'denied_wrong_facility',
        reason: 'Unit no permitida',
      };
    }
    // Las ventanas horarias (allowedHours.windows) se evalúan aparte en
    // `checkAccessWindows` (necesita la TZ del local).
    return null;
  }

  private async log(entry: {
    tenantId: string;
    deviceId: string | null;
    credentialId: string | null;
    customerId: string | null;
    method: AccessMethodValue;
    result: AccessResultValue;
    attemptedValue: string | null;
    reason: string | null;
    ipAddress?: string | undefined;
  }): Promise<void> {
    try {
      await this.admin.accessLog.create({
        data: {
          tenantId: entry.tenantId,
          deviceId: entry.deviceId,
          credentialId: entry.credentialId,
          customerId: entry.customerId,
          method: entry.method as AccessMethod,
          result: entry.result as AccessResult,
          attemptedValue: entry.attemptedValue,
          reason: entry.reason,
          ipAddress: entry.ipAddress ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `No se pudo escribir access_log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Helper para logear un error de device unknown (sin device row). */
  async logDeviceUnknown(args: {
    method: AccessMethodValue;
    credential: string;
    deviceRef: string;
    ipAddress?: string | undefined;
  }): Promise<void> {
    this.logger.warn(
      `[access.verify] device desconocido o api key invalida: deviceRef=${args.deviceRef}`,
    );
    // No persistimos en access_logs porque no tenemos tenantId resuelto.
  }
}
