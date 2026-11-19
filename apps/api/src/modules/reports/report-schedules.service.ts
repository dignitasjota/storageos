import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CreateReportScheduleInput,
  type Permission,
  permissionsForRole,
  type ReportScheduleDto,
  type UpdateReportScheduleInput,
} from '@storageos/shared';

import { buildReportFileToken, reportFileKey } from '../../common/report-file-token';
import { tenantTimezone } from '../analytics/business-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';

import { nextScheduleRun, previousPeriod } from './report-schedule-time';
import { ReportsService, type Viewer } from './reports.service';

import type { Env } from '../../config/env.schema';
import type { Prisma, ReportSchedule } from '@storageos/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Parámetros de fecha: no se guardan, salen del periodo anterior en cada envío. */
const DATE_PARAMS = ['from', 'to', 'month', 'atDate'];
/** Envíos activos por negocio, como mucho. */
const MAX_SCHEDULES = 20;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Informes que se envían solos por correo cada semana o cada mes, con el
 * periodo que acaba de terminar. Cada envío sale con los permisos y los locales
 * que tenga en ese momento quien lo programó.
 */
@Injectable()
export class ReportSchedulesService {
  private readonly logger = new Logger(ReportSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly reports: ReportsService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Las fechas que tendrá el próximo envío, para los parámetros que las piden. */
  private withPeriod(
    code: string,
    params: Record<string, unknown>,
    frequency: string,
    timezone: string,
    at: Date,
  ): Record<string, unknown> {
    const schema = this.reports.generatorOf(code)?.paramsSchema ?? {};
    const period = previousPeriod(frequency, timezone, at);
    const out = { ...params };
    for (const k of DATE_PARAMS) {
      if (k in schema) out[k] = period[k as keyof typeof period];
    }
    return out;
  }

  private visibleWhere(user: Viewer): Prisma.ReportScheduleWhereInput {
    // Quien solo ve algunos locales ve los suyos (los demás pueden llevar otros).
    return user.facilityScope ? { createdByUserId: user.sub } : {};
  }

  async list(user: Viewer): Promise<ReportScheduleDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.reportSchedule.findMany({
          where: this.visibleWhere(user),
          include: { createdBy: { select: { fullName: true } } },
          orderBy: { createdAt: 'desc' },
        }),
      user.tenantId,
    );
    return this.toDtos(user.tenantId, rows);
  }

  async create(user: Viewer, input: CreateReportScheduleInput): Promise<ReportScheduleDto> {
    const generator = this.reports.generatorOf(input.generator);
    const timezone = await this.prisma.withTenant(
      (tx) => tenantTimezone(tx, user.tenantId),
      user.tenantId,
    );
    const nextRunAt = nextScheduleRun(
      {
        frequency: input.frequency,
        weekday: input.weekday ?? null,
        dayOfMonth: input.dayOfMonth ?? null,
        hour: input.hour,
      },
      timezone,
    );
    // Se comprueba como si se pidiera ahora, con las fechas del primer envío.
    const { params } = await this.reports.prepare(user, {
      generator: input.generator,
      format: input.format,
      params: this.withPeriod(input.generator, input.params, input.frequency, timezone, nextRunAt),
    });
    for (const k of DATE_PARAMS) delete params[k];
    if (!generator) throw new NotFoundException({ code: 'report_generator_not_found' });

    const active = await this.prisma.withTenant(
      (tx) => tx.reportSchedule.count({ where: { isActive: true } }),
      user.tenantId,
    );
    if (active >= MAX_SCHEDULES) {
      throw new BadRequestException({
        code: 'too_many_schedules',
        message: `Como mucho ${MAX_SCHEDULES} envíos programados a la vez`,
      });
    }
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.reportSchedule.create({
          data: {
            tenantId: user.tenantId,
            createdByUserId: user.sub,
            generatorCode: input.generator,
            format: input.format,
            params: params as Prisma.InputJsonValue,
            frequency: input.frequency,
            weekday: input.frequency === 'weekly' ? (input.weekday ?? 1) : null,
            dayOfMonth: input.frequency === 'monthly' ? (input.dayOfMonth ?? 1) : null,
            hour: input.hour,
            recipients: [...new Set(input.recipients)],
            nextRunAt,
          },
          include: { createdBy: { select: { fullName: true } } },
        }),
      user.tenantId,
    );
    return (await this.toDtos(user.tenantId, [row]))[0]!;
  }

  private async findVisible(user: Viewer, id: string) {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.reportSchedule.findFirst({
          where: { id, ...this.visibleWhere(user) },
          include: { createdBy: { select: { fullName: true } } },
        }),
      user.tenantId,
    );
    if (!row) {
      throw new NotFoundException({ code: 'schedule_not_found', message: 'Envío no encontrado' });
    }
    return row;
  }

  async update(
    user: Viewer,
    id: string,
    input: UpdateReportScheduleInput,
  ): Promise<ReportScheduleDto> {
    const row = await this.findVisible(user, id);
    const timezone = await this.prisma.withTenant(
      (tx) => tenantTimezone(tx, user.tenantId),
      user.tenantId,
    );
    const hour = input.hour ?? row.hour;
    const reactivated = input.isActive === true && !row.isActive;
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.reportSchedule.update({
          where: { id: row.id },
          data: {
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.recipients ? { recipients: [...new Set(input.recipients)] } : {}),
            ...(input.hour !== undefined || reactivated
              ? { hour, nextRunAt: nextScheduleRun({ ...row, hour }, timezone), lastError: null }
              : {}),
          },
          include: { createdBy: { select: { fullName: true } } },
        }),
      user.tenantId,
    );
    return (await this.toDtos(user.tenantId, [updated]))[0]!;
  }

  async remove(user: Viewer, id: string): Promise<void> {
    const row = await this.findVisible(user, id);
    await this.prisma.withTenant(
      (tx) => tx.reportSchedule.deleteMany({ where: { id: row.id } }),
      user.tenantId,
    );
  }

  /** Lo envía ya (sin mover el próximo envío). */
  async sendNow(user: Viewer, id: string): Promise<ReportScheduleDto> {
    const row = await this.findVisible(user, id);
    await this.execute(row);
    return (await this.toDtos(user.tenantId, [await this.findVisible(user, id)]))[0]!;
  }

  /** Los envíos que tocan (la tarea programada). Cada uno se reserva antes. */
  async runDue(now = new Date()): Promise<number> {
    const due = await this.admin.reportSchedule.findMany({
      where: { isActive: true, nextRunAt: { lte: now } },
      take: 50,
      orderBy: { nextRunAt: 'asc' },
    });
    let sent = 0;
    for (const s of due) {
      const timezone = await this.prisma.withTenant(
        (tx) => tenantTimezone(tx, s.tenantId),
        s.tenantId,
      );
      // Reserva: con varias réplicas, solo una lo envía.
      const claimed = await this.admin.reportSchedule.updateMany({
        where: { id: s.id, nextRunAt: s.nextRunAt, isActive: true },
        data: { nextRunAt: nextScheduleRun(s, timezone, now) },
      });
      if (claimed.count === 0) continue;
      if (await this.execute(s, now)) sent += 1;
    }
    return sent;
  }

  /** Genera el informe con los permisos actuales de quien lo programó y lo envía. */
  private async execute(s: ReportSchedule, at = new Date()): Promise<boolean> {
    const fail = async (message: string, deactivate = false) => {
      await this.admin.reportSchedule.update({
        where: { id: s.id },
        data: {
          lastError: message,
          lastRunAt: new Date(),
          ...(deactivate ? { isActive: false } : {}),
        },
      });
      return false;
    };
    const user = s.createdByUserId
      ? await this.admin.user.findFirst({
          where: { id: s.createdByUserId, tenantId: s.tenantId, isActive: true },
          select: {
            id: true,
            role: true,
            tenantRole: { select: { permissions: true } },
            facilities: { select: { facilityId: true } },
          },
        })
      : null;
    if (!user) {
      return fail('Quien lo programó ya no está en el equipo: el envío se ha pausado.', true);
    }
    const viewer: Viewer = {
      sub: user.id,
      tenantId: s.tenantId,
      role: user.role,
      permissions:
        (user.tenantRole?.permissions as Permission[] | undefined) ?? permissionsForRole(user.role),
      facilityScope: user.facilities.length ? user.facilities.map((f) => f.facilityId) : null,
    };
    const generator = this.reports.generatorOf(s.generatorCode);
    if (!generator || !this.reports.allowed(generator, viewer)) {
      return fail('Quien lo programó ya no puede ver este informe: el envío se ha pausado.', true);
    }
    const timezone = await this.prisma.withTenant(
      (tx) => tenantTimezone(tx, s.tenantId),
      s.tenantId,
    );
    let params: Record<string, unknown>;
    try {
      ({ params } = await this.reports.prepare(viewer, {
        generator: s.generatorCode,
        format: s.format,
        params: this.withPeriod(
          s.generatorCode,
          s.params as Record<string, unknown>,
          s.frequency,
          timezone,
          at,
        ),
      }));
    } catch (err) {
      const message =
        (err as { response?: { message?: string } }).response?.message ?? 'Parámetros no válidos';
      return fail(`${message}: el envío se ha pausado.`, true);
    }
    const run = await this.admin.reportRun.create({
      data: {
        tenantId: s.tenantId,
        triggeredByUserId: user.id,
        generatorCode: s.generatorCode,
        format: s.format,
        status: 'pending',
        params: params as Prisma.InputJsonValue,
        facilityScoped: !!viewer.facilityScope,
        facilityScope: viewer.facilityScope ?? [],
      },
    });
    try {
      await this.reports.generate({ tenantId: s.tenantId, runId: run.id });
    } catch (err) {
      this.logger.warn(`Envío ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const done = await this.admin.reportRun.findUnique({ where: { id: run.id } });
    if (!done || done.status !== 'done' || !done.expiresAt) {
      await this.admin.reportSchedule.update({
        where: { id: s.id },
        data: { lastRunAt: new Date(), lastRunId: run.id, lastError: done?.errorMessage ?? null },
      });
      return false;
    }
    await this.sendEmail(s, generator.name, run.id, done.expiresAt, params);
    await this.admin.reportSchedule.update({
      where: { id: s.id },
      data: { lastRunAt: new Date(), lastRunId: run.id, lastError: null },
    });
    return true;
  }

  private async sendEmail(
    s: ReportSchedule,
    name: string,
    runId: string,
    expiresAt: Date,
    params: Record<string, unknown>,
  ): Promise<void> {
    const key = reportFileKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    const token = buildReportFileToken(key, s.tenantId, runId, expiresAt);
    const url = `${this.config.get('API_BASE_URL', { infer: true })}/v1/public/report-files/${token}`;
    const period =
      typeof params.from === 'string' && typeof params.to === 'string'
        ? `del ${params.from.split('-').reverse().join('/')} al ${params.to.split('-').reverse().join('/')}`
        : typeof params.month === 'string'
          ? new Date(`${params.month}-01T00:00:00Z`).toLocaleDateString('es-ES', {
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            })
          : null;
    const subject = `${name}${period ? ` · ${period}` : ''}`;
    const until = expiresAt.toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Madrid',
    });
    const html = `<p>Hola,</p>
<p>Aquí tienes el informe <strong>${escapeHtml(name)}</strong>${period ? ` ${escapeHtml(period)}` : ''}, en ${s.format === 'xlsx' ? 'Excel' : 'PDF'}.</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">Descargar el informe</a></p>
<p style="color:#666;font-size:13px">El enlace funciona hasta el ${escapeHtml(until)}. Este envío está programado en Informes; desde allí puedes pausarlo o cambiarlo.</p>`;
    const text = [
      `Aquí tienes el informe «${name}»${period ? ` ${period}` : ''}.`,
      `Descargar: ${url}`,
      `El enlace funciona hasta el ${until}.`,
    ].join('\n');
    for (const to of s.recipients) {
      await this.email
        .sendRendered({ to, tenantId: s.tenantId, subject, html, text })
        .catch((err: unknown) =>
          this.logger.warn(
            `No se pudo enviar el informe ${runId}: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }
  }

  private async toDtos(
    tenantId: string,
    rows: (ReportSchedule & { createdBy?: { fullName: string } | null })[],
  ): Promise<ReportScheduleDto[]> {
    const ids = (k: string) =>
      rows
        .map((r) => (r.params as Record<string, unknown>)[k])
        .filter((v): v is string => typeof v === 'string' && UUID.test(v));
    const names = new Map<string, string>();
    const facilityIds = ids('facilityId');
    const ownerIds = ids('ownerId');
    if (facilityIds.length || ownerIds.length) {
      await this.prisma.withTenant(async (tx) => {
        for (const f of await tx.facility.findMany({
          where: { id: { in: facilityIds } },
          select: { id: true, name: true },
        })) {
          names.set(f.id, f.name);
        }
        for (const o of await tx.owner.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, legalName: true },
        })) {
          names.set(o.id, o.legalName);
        }
      }, tenantId);
    }
    return rows.map((r) => {
      const p = r.params as Record<string, unknown>;
      const label = [p.ownerId, p.facilityId]
        .filter((v): v is string => typeof v === 'string' && names.has(v))
        .map((v) => names.get(v)!)
        .join(' · ');
      return {
        id: r.id,
        generatorCode: r.generatorCode,
        generatorName: this.reports.generatorOf(r.generatorCode)?.name ?? 'Informe',
        format: r.format,
        paramsLabel: label || null,
        frequency: r.frequency as 'weekly' | 'monthly',
        weekday: r.weekday,
        dayOfMonth: r.dayOfMonth,
        hour: r.hour,
        recipients: r.recipients,
        isActive: r.isActive,
        nextRunAt: r.nextRunAt.toISOString(),
        lastRunAt: r.lastRunAt?.toISOString() ?? null,
        lastError: r.lastError,
        createdByName: r.createdBy?.fullName ?? null,
      };
    });
  }
}
