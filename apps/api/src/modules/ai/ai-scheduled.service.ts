import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  type AiScheduledQuestionDto,
  type CreateAiScheduledQuestionInput,
  type Permission,
  permissionsForRole,
  type UpdateAiScheduledQuestionInput,
} from '@storageos/shared';

import { invoiceFacilityWhere, optionalFacilityWhere } from '../../common/facility-scope';
import { todayInTimezone, zonedDayStart } from '../../common/format';
import { tenantTimezone } from '../analytics/business-metrics';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';

import { AiService } from './ai.service';

import type { Env } from '../../config/env.schema';
import type { AiScheduledQuestion, Prisma } from '@storageos/database';

const DAY = 86_400_000;
/** Preguntas programadas activas por persona, como mucho. */
const MAX_PER_USER = 10;

interface Viewer {
  sub: string;
  tenantId: string;
  role: string;
  permissions?: Permission[];
  facilityScope?: string[] | null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Siguiente vez después de `after`: cada día o un día de la semana, a la hora indicada. */
export function nextQuestionRun(
  q: { frequency: string; weekday: number | null; hour: number },
  timezone: string,
  after: Date = new Date(),
): Date {
  const today = todayInTimezone(timezone, after);
  for (let i = 0; i < 9; i++) {
    const day = new Date(today.getTime() + i * DAY);
    const at = new Date(
      zonedDayStart(day.toISOString().slice(0, 10), timezone).getTime() + q.hour * 3_600_000,
    );
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if ((q.frequency === 'daily' || weekday === (q.weekday ?? 1)) && at > after) return at;
  }
  return new Date(after.getTime() + DAY);
}

/**
 * Preguntas al asistente que se hacen solas y llegan por correo, y las
 * sugerencias del día para empezar una conversación.
 */
@Injectable()
export class AiScheduledService {
  private readonly logger = new Logger(AiScheduledService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly ai: AiService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(user: Viewer): Promise<AiScheduledQuestionDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.aiScheduledQuestion.findMany({
          where: { userId: user.sub },
          orderBy: { createdAt: 'desc' },
        }),
      user.tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async create(
    user: Viewer,
    input: CreateAiScheduledQuestionInput,
  ): Promise<AiScheduledQuestionDto> {
    const timezone = await this.prisma.withTenant(
      (tx) => tenantTimezone(tx, user.tenantId),
      user.tenantId,
    );
    const count = await this.prisma.withTenant(
      (tx) => tx.aiScheduledQuestion.count({ where: { userId: user.sub, isActive: true } }),
      user.tenantId,
    );
    if (count >= MAX_PER_USER) {
      throw new BadRequestException({
        code: 'too_many_scheduled_questions',
        message: `Como mucho ${MAX_PER_USER} preguntas programadas a la vez`,
      });
    }
    const weekday = input.frequency === 'weekly' ? (input.weekday ?? 1) : null;
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.aiScheduledQuestion.create({
          data: {
            tenantId: user.tenantId,
            userId: user.sub,
            question: input.question,
            frequency: input.frequency,
            weekday,
            hour: input.hour,
            nextRunAt: nextQuestionRun(
              { frequency: input.frequency, weekday, hour: input.hour },
              timezone,
            ),
          },
        }),
      user.tenantId,
    );
    return this.toDto(row);
  }

  private async findOwned(user: Viewer, id: string) {
    const row = await this.prisma.withTenant(
      (tx) => tx.aiScheduledQuestion.findFirst({ where: { id, userId: user.sub } }),
      user.tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'scheduled_question_not_found',
        message: 'Pregunta programada no encontrada',
      });
    }
    return row;
  }

  async update(
    user: Viewer,
    id: string,
    input: UpdateAiScheduledQuestionInput,
  ): Promise<AiScheduledQuestionDto> {
    const row = await this.findOwned(user, id);
    const timezone = await this.prisma.withTenant(
      (tx) => tenantTimezone(tx, user.tenantId),
      user.tenantId,
    );
    const hour = input.hour ?? row.hour;
    const reschedule = input.hour !== undefined || (input.isActive === true && !row.isActive);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.aiScheduledQuestion.update({
          where: { id: row.id },
          data: {
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(reschedule
              ? { hour, nextRunAt: nextQuestionRun({ ...row, hour }, timezone), lastError: null }
              : {}),
          },
        }),
      user.tenantId,
    );
    return this.toDto(updated);
  }

  async remove(user: Viewer, id: string): Promise<void> {
    const row = await this.findOwned(user, id);
    await this.prisma.withTenant(
      (tx) => tx.aiScheduledQuestion.deleteMany({ where: { id: row.id } }),
      user.tenantId,
    );
  }

  /** La hace ya (y manda el correo), sin mover la próxima vez. */
  async sendNow(user: Viewer, id: string): Promise<AiScheduledQuestionDto> {
    const row = await this.findOwned(user, id);
    await this.execute(row);
    return this.toDto(await this.findOwned(user, id));
  }

  /** Cada cuarto de hora, las que tocan. El asistente vive en el API (no en el worker). */
  @Cron('*/15 * * * *', { name: 'ai.scheduled-questions' })
  async cron(): Promise<void> {
    try {
      await this.runDue();
    } catch (err) {
      this.logger.error(`Preguntas programadas: ${err instanceof Error ? err.message : err}`);
    }
  }

  async runDue(now = new Date()): Promise<number> {
    const due = await this.admin.aiScheduledQuestion.findMany({
      where: { isActive: true, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: 30,
    });
    let done = 0;
    for (const q of due) {
      const timezone = await this.prisma.withTenant(
        (tx) => tenantTimezone(tx, q.tenantId),
        q.tenantId,
      );
      // Reserva: con varias réplicas del API, solo una la hace.
      const claimed = await this.admin.aiScheduledQuestion.updateMany({
        where: { id: q.id, nextRunAt: q.nextRunAt, isActive: true },
        data: { nextRunAt: nextQuestionRun(q, timezone, now) },
      });
      if (claimed.count === 0) continue;
      if (await this.execute(q)) done += 1;
    }
    return done;
  }

  /** Pregunta con los permisos y locales que tenga ahora esa persona, y le manda la respuesta. */
  private async execute(q: AiScheduledQuestion): Promise<boolean> {
    const fail = async (message: string, pause = false) => {
      await this.admin.aiScheduledQuestion.update({
        where: { id: q.id },
        data: { lastError: message, lastRunAt: new Date(), ...(pause ? { isActive: false } : {}) },
      });
      return false;
    };
    const user = await this.admin.user.findFirst({
      where: { id: q.userId, tenantId: q.tenantId, isActive: true },
      select: {
        email: true,
        fullName: true,
        role: true,
        tenantRole: { select: { permissions: true } },
        facilities: { select: { facilityId: true } },
      },
    });
    if (!user)
      return fail('Esta persona ya no está en el equipo: la pregunta se ha pausado.', true);
    const permissions =
      (user.tenantRole?.permissions as Permission[] | undefined) ?? permissionsForRole(user.role);
    if (!permissions.includes('ai:use') || !(await this.ai.isAiEnabled(q.tenantId))) {
      return fail('El asistente ya no está disponible para esta cuenta: se ha pausado.', true);
    }
    let result;
    try {
      result = await this.ai.chat({
        tenantId: q.tenantId,
        userId: q.userId,
        permissions,
        facilityScope: user.facilities.length ? user.facilities.map((f) => f.facilityId) : null,
        input: { content: q.question },
      });
    } catch (err) {
      const message =
        (err as { response?: { message?: string } }).response?.message ??
        'No se ha podido obtener la respuesta';
      return fail(message);
    }
    const link = `${this.config.get('WEB_BASE_URL', { infer: true })}/assistant?c=${result.conversationId}`;
    const answer = result.message.content;
    await this.email
      .sendRendered({
        to: user.email,
        kind: 'staff_notice',
        subject: `Tu pregunta al asistente: ${q.question.slice(0, 80)}`,
        html: `<p>Hola${user.fullName ? ` ${escapeHtml(user.fullName.split(' ')[0]!)}` : ''},</p>
<p>Esta es la respuesta a la pregunta que programaste:</p>
<p style="color:#555"><em>${escapeHtml(q.question)}</em></p>
<div style="white-space:pre-wrap;border-left:3px solid #2563eb;padding:8px 12px;background:#f8fafc">${escapeHtml(answer)}</div>
<p><a href="${escapeHtml(link)}">Abrir la conversación en TrasterOS</a></p>
<p style="color:#666;font-size:13px">La puedes pausar o quitar en el Asistente IA → Preguntas programadas.</p>`,
        text: `${q.question}\n\n${answer}\n\nAbrir: ${link}`,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `No se pudo enviar la respuesta ${q.id}: ${err instanceof Error ? err.message : err}`,
        ),
      );
    await this.admin.aiScheduledQuestion.update({
      where: { id: q.id },
      data: { lastRunAt: new Date(), lastConversationId: result.conversationId, lastError: null },
    });
    return true;
  }

  /**
   * Preguntas para empezar según lo que pasa hoy (lo que ve esta persona):
   * facturas vencidas, entradas y salidas, contratos que vencen, tareas
   * atrasadas y trasteros libres. Se completan con las de siempre.
   */
  async suggestions(user: Viewer): Promise<string[]> {
    const can = (p: Permission) =>
      (user.permissions ?? permissionsForRole(user.role as never)).includes(p);
    const scope = user.facilityScope ?? null;
    const unitScope = scope ? { facilityId: { in: scope } } : {};
    const contractScope: Prisma.ContractWhereInput = scope ? { unit: unitScope } : {};
    const counts = await this.prisma.withTenant(async (tx) => {
      const tz = await tenantTimezone(tx, user.tenantId);
      const today = todayInTimezone(tz);
      const in30 = new Date(today.getTime() + 30 * DAY);
      const live = {
        deletedAt: null,
        status: { in: ['active', 'ending'] as ('active' | 'ending')[] },
      };
      const zero = Promise.resolve(0);
      const [overdue, moveIns, moveOuts, ending, lateTasks, free] = await Promise.all([
        can('invoices:read')
          ? tx.invoice.count({
              where: {
                deletedAt: null,
                kind: 'invoice',
                OR: [{ status: 'overdue' }, { status: 'issued', dueDate: { lt: today } }],
                AND: [(invoiceFacilityWhere(scope) ?? {}) as Prisma.InvoiceWhereInput],
              },
            })
          : zero,
        can('contracts:read')
          ? tx.contract.count({ where: { ...live, startDate: today, ...contractScope } })
          : zero,
        can('contracts:read')
          ? tx.contract.count({ where: { ...live, endDate: today, ...contractScope } })
          : zero,
        can('contracts:read')
          ? tx.contract.count({
              where: {
                ...live,
                autoRenew: false,
                endDate: { gte: today, lte: in30 },
                ...contractScope,
              },
            })
          : zero,
        can('tasks:read')
          ? tx.task.count({
              where: {
                deletedAt: null,
                status: { in: ['open', 'in_progress'] },
                dueDate: { lt: today },
                ...(optionalFacilityWhere(scope) ?? {}),
              },
            })
          : zero,
        can('units:read')
          ? tx.unit.count({
              where: { status: 'available', facility: { deletedAt: null }, ...unitScope },
            })
          : zero,
      ]);
      return { overdue, moveIns, moveOuts, ending, lateTasks, free };
    }, user.tenantId);

    const out: string[] = [];
    if (counts.overdue > 0) {
      out.push(
        `Tengo ${counts.overdue} ${counts.overdue === 1 ? 'factura vencida' : 'facturas vencidas'}: ¿a quién reclamo primero?`,
      );
    }
    if (counts.moveIns > 0) out.push('¿Quién entra hoy y qué le falta (firma, pago, acceso)?');
    if (counts.moveOuts > 0) out.push('¿Qué salidas tengo hoy y qué fianzas hay que liquidar?');
    if (counts.ending > 0) {
      out.push(
        `${counts.ending} ${counts.ending === 1 ? 'contrato vence' : 'contratos vencen'} este mes sin renovarse solos: ¿cuáles son?`,
      );
    }
    if (counts.lateTasks > 0) out.push('¿Qué tareas tengo atrasadas?');
    if (counts.free > 0) out.push('¿Qué trasteros llevan más tiempo libres y a qué precio?');
    const fallback = [
      ...(can('analytics:read')
        ? ['Dame las métricas del negocio (MRR, contratos, pendiente).']
        : []),
      ...(can('units:read') ? ['¿Cuál es la ocupación actual de mis locales?'] : []),
      ...(can('invoices:read') ? ['¿Cuánto he facturado y cobrado los últimos 6 meses?'] : []),
      'Redacta un email recordando un pago pendiente.',
    ];
    for (const f of fallback) if (out.length < 6 && !out.includes(f)) out.push(f);
    return out.slice(0, 6);
  }

  private toDto(r: AiScheduledQuestion): AiScheduledQuestionDto {
    return {
      id: r.id,
      question: r.question,
      frequency: r.frequency as 'daily' | 'weekly',
      weekday: r.weekday,
      hour: r.hour,
      isActive: r.isActive,
      nextRunAt: r.nextRunAt.toISOString(),
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastConversationId: r.lastConversationId,
      lastError: r.lastError,
    };
  }
}
