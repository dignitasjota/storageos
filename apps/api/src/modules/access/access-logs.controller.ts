import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  type AccessLogDto,
  type AccessReportDto,
  type AccessMethodValue,
  AccessResultEnum,
  type AccessResultValue,
} from '@storageos/shared';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { resolveFacilityFilter } from '../../common/facility-scope';
import { PrismaService } from '../database/prisma.service';

import type { AccessDevice, AccessLog, Customer, CustomerType, Prisma } from '@storageos/database';

function customerDisplay(
  c: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null | undefined,
): string | null {
  if (!c) return null;
  if (c.customerType === ('business' as CustomerType)) return c.companyName ?? 'Empresa sin nombre';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Sin nombre';
}

type AccessLogWithIncludes = AccessLog & {
  device?: Pick<AccessDevice, 'name'> | null;
  customer?: Pick<Customer, 'customerType' | 'firstName' | 'lastName' | 'companyName'> | null;
};

function toDto(l: AccessLogWithIncludes): AccessLogDto {
  return {
    id: l.id,
    deviceId: l.deviceId,
    deviceName: l.device?.name ?? null,
    credentialId: l.credentialId,
    customerId: l.customerId,
    customerName: customerDisplay(l.customer),
    method: l.method as AccessMethodValue,
    result: l.result as AccessResultValue,
    attemptedValue: l.attemptedValue,
    reason: l.reason,
    ipAddress: l.ipAddress,
    metadata: (l.metadata ?? {}) as Record<string, unknown>,
    occurredAt: l.occurredAt.toISOString(),
  };
}

function parseResult(value: string | undefined): AccessResultValue | undefined {
  if (!value) return undefined;
  const parsed = AccessResultEnum.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const INCLUDE = {
  device: { select: { name: true } },
  customer: {
    select: {
      customerType: true,
      firstName: true,
      lastName: true,
      companyName: true,
    },
  },
} satisfies Prisma.AccessLogInclude;

@RequirePermission('access:read')
@Controller('access/logs')
@RequireFeature('access_control')
export class AccessLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('customerId') customerId?: string,
    @Query('deviceId') deviceId?: string,
    @Query('result') result?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('facilityId') facilityId?: string,
    /** Página siguiente: registros anteriores a esta fecha (ISO). */
    @Query('before') before?: string,
  ): Promise<AccessLogDto[]> {
    // Local del dispositivo (el elegido en la cabecera, dentro de los del usuario).
    const ids = resolveFacilityFilter(user.facilityScope ?? null, facilityId);
    if (ids === null) return [];
    const where: Prisma.AccessLogWhereInput = ids ? { device: { facilityId: { in: ids } } } : {};
    if (customerId) where.customerId = customerId;
    if (deviceId) where.deviceId = deviceId;
    const parsedResult = parseResult(result);
    if (parsedResult) where.result = parsedResult;
    // Un día suelto (YYYY-MM-DD) en `to` incluye ese día entero.
    const toDate = to
      ? /^\d{4}-\d{2}-\d{2}$/.test(to)
        ? new Date(`${to}T23:59:59.999Z`)
        : new Date(to)
      : null;
    const beforeDate = before ? new Date(before) : null;
    for (const d of [from ? new Date(from) : null, toDate, beforeDate]) {
      if (d && Number.isNaN(d.getTime())) {
        throw new BadRequestException({ code: 'invalid_date', message: 'Fecha no válida' });
      }
    }
    if (from || toDate || beforeDate) {
      where.occurredAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(toDate ? { lte: toDate } : {}),
        ...(beforeDate ? { lt: beforeDate } : {}),
      };
    }
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.accessLog.findMany({
          where,
          include: INCLUDE,
          orderBy: { occurredAt: 'desc' },
          take: 200,
        }),
      user.tenantId,
    );
    return rows.map((r) => toDto(r as AccessLogWithIncludes));
  }

  /**
   * Informe de accesos de los últimos días: entradas y denegaciones por día y
   * por hora (en la hora del tenant), quién entra más y quién acumula
   * denegaciones (PIN mal o acceso cortado).
   */
  @Get('report')
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') daysRaw?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<AccessReportDto> {
    const days = Math.min(Math.max(Number.parseInt(daysRaw ?? '30', 10) || 30, 1), 90);
    const ids = resolveFacilityFilter(user.facilityScope ?? null, facilityId);
    const since = new Date(Date.now() - days * 86_400_000);
    const tz = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: user.tenantId }, select: { timezone: true } }),
      user.tenantId,
    );
    const rows =
      ids === null
        ? []
        : await this.prisma.withTenant(
            (tx) =>
              tx.accessLog.findMany({
                where: {
                  occurredAt: { gte: since },
                  ...(ids ? { device: { facilityId: { in: ids } } } : {}),
                },
                select: {
                  occurredAt: true,
                  result: true,
                  reason: true,
                  customerId: true,
                  customer: {
                    select: {
                      customerType: true,
                      firstName: true,
                      lastName: true,
                      companyName: true,
                    },
                  },
                },
                take: 50_000,
              }),
            user.tenantId,
          );
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz?.timezone ?? 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    // Días de calendario hasta hoy en la hora del tenant (restar 24 h repetiría
    // un día el del cambio de hora).
    const todayParts = fmt.formatToParts(new Date());
    const tp = (t: string) => Number(todayParts.find((p) => p.type === t)?.value);
    const byDay = new Map<string, { allowed: number; denied: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(tp('year'), tp('month') - 1, tp('day') - i));
      byDay.set(d.toISOString().slice(0, 10), { allowed: 0, denied: 0 });
    }
    const byHour = Array.from({ length: 24 }, () => 0);
    const visits = new Map<string, { name: string; visits: number }>();
    const denied = new Map<
      string,
      { customerId: string | null; name: string; denied: number; reason: string }
    >();
    let allowed = 0;
    let deniedTotal = 0;
    for (const r of rows) {
      const parts = fmt.formatToParts(r.occurredAt);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      const day = `${get('year')}-${get('month')}-${get('day')}`;
      const bucket = byDay.get(day);
      const name = customerDisplay(r.customer) ?? 'Sin identificar';
      if (r.result === 'allowed') {
        allowed += 1;
        if (bucket) bucket.allowed += 1;
        const h = Number.parseInt(get('hour'), 10);
        if (h >= 0 && h < 24) byHour[h] = (byHour[h] ?? 0) + 1;
        if (r.customerId) {
          const v = visits.get(r.customerId) ?? { name, visits: 0 };
          v.visits += 1;
          visits.set(r.customerId, v);
        }
      } else {
        deniedTotal += 1;
        if (bucket) bucket.denied += 1;
        const key = r.customerId ?? `none:${r.result}`;
        const d = denied.get(key) ?? {
          customerId: r.customerId,
          name,
          denied: 0,
          reason: r.reason ?? r.result,
        };
        d.denied += 1;
        denied.set(key, d);
      }
    }
    return {
      days,
      totals: { allowed, denied: deniedTotal, uniqueCustomers: visits.size },
      byDay: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
      byHour,
      topCustomers: [...visits.entries()]
        .map(([customerId, v]) => ({ customerId, customerName: v.name, visits: v.visits }))
        .sort((a, b) => b.visits - a.visits)
        .slice(0, 10),
      topDenied: [...denied.values()]
        .map((d) => ({
          customerId: d.customerId,
          customerName: d.name,
          denied: d.denied,
          reason: d.reason,
        }))
        .sort((a, b) => b.denied - a.denied)
        .slice(0, 10),
    };
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AccessLogDto> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.accessLog.findFirst({
          where: { id },
          include: INCLUDE,
        }),
      user.tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'access_log_not_found',
        message: 'Registro de acceso no encontrado',
      });
    }
    return toDto(row as AccessLogWithIncludes);
  }
}
