import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  PLATFORM_LEAD_REPLY_TYPES,
  PlatformLeadSequenceStepSchema,
  platformLeadName,
  renderPlatformLeadTemplate,
  type PlatformLeadSequenceDto,
  type PlatformLeadSequenceStateDto,
  type PlatformLeadSequenceStep,
  type UpsertPlatformLeadSequenceInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../../database/prisma-admin.service';

import { PlatformLeadMailService } from './platform-lead-mail.service';

const DAY = 86_400_000;
/** Fases en las que tiene sentido seguir escribiéndole. */
const OPEN_FOR_SEQUENCE = new Set(['new', 'contacted', 'interested']);

export type SequenceStopReason =
  | 'replied'
  | 'stage'
  | 'discarded'
  | 'manual'
  | 'no_email'
  | 'finished'
  | 'merged';

const parseSteps = (raw: Prisma.JsonValue): PlatformLeadSequenceStep[] => {
  const parsed = PlatformLeadSequenceStepSchema.array().safeParse(raw);
  return parsed.success ? parsed.data : [];
};

/**
 * Secuencias de correos a los leads que no contestan: pasos por días desde el
 * primer correo o la propuesta. Cada paso se reserva antes de enviarlo (dos
 * réplicas o dos ejecuciones no lo mandan dos veces) y la secuencia se para
 * sola si el lead contesta (correo, llamada, demo o reunión), deja de estar
 * abierto (cuenta, cliente o perdido) o se descarta. El envío corre en el
 * worker (`PlatformLeadSequencesCron`).
 */
@Injectable()
export class PlatformLeadSequencesService {
  private readonly logger = new Logger(PlatformLeadSequencesService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly mail: PlatformLeadMailService,
  ) {}

  // ------------------------------------------------------------ catálogo

  async list(): Promise<PlatformLeadSequenceDto[]> {
    const [rows, active] = await Promise.all([
      this.admin.platformLeadSequence.findMany({
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      this.admin.platformLeadSequenceEnrollment.groupBy({
        by: ['sequenceId'],
        where: { status: 'active' },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(active.map((a) => [a.sequenceId, a._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      steps: parseSteps(r.steps),
      isActive: r.isActive,
      isDefault: r.isDefault,
      activeCount: counts.get(r.id) ?? 0,
    }));
  }

  async save(
    id: string | null,
    input: UpsertPlatformLeadSequenceInput,
  ): Promise<PlatformLeadSequenceDto> {
    const steps = [...input.steps].sort((a, b) => a.day - b.day);
    const templateIds = steps.map((s) => s.templateId).filter((t): t is string => !!t);
    if (templateIds.length) {
      const found = await this.admin.salesTemplate.count({
        where: { id: { in: [...new Set(templateIds)] }, channel: 'email' },
      });
      if (found !== new Set(templateIds).size) {
        throw new BadRequestException({
          code: 'template_not_found',
          message: 'Alguna plantilla no existe o no es de correo',
        });
      }
    }
    const data = {
      name: input.name,
      description: input.description?.trim() || null,
      steps: steps.map((s) => ({
        day: s.day,
        ...(s.templateId ? { templateId: s.templateId } : {}),
        ...(s.subject ? { subject: s.subject } : {}),
        ...(s.body ? { body: s.body } : {}),
      })) as unknown as Prisma.InputJsonValue,
      isActive: input.isActive,
      // Una por defecto como mucho: se marca después de quitársela a la otra.
      isDefault: false,
    };
    const row = await this.admin.$transaction(async (tx) => {
      let saved;
      if (id) {
        const before = await tx.platformLeadSequence.findUnique({ where: { id } });
        if (!before) {
          throw new NotFoundException({
            code: 'sequence_not_found',
            message: 'Secuencia no encontrada',
          });
        }
        saved = await tx.platformLeadSequence.update({ where: { id }, data });
      } else {
        saved = await tx.platformLeadSequence.create({ data });
      }
      if (input.isDefault && input.isActive) {
        await tx.platformLeadSequence.updateMany({
          where: { isDefault: true, id: { not: saved.id } },
          data: { isDefault: false },
        });
        saved = await tx.platformLeadSequence.update({
          where: { id: saved.id },
          data: { isDefault: true },
        });
      }
      return saved;
    });
    return (await this.list()).find((s) => s.id === row.id)!;
  }

  /** Con leads que la han usado se desactiva (conserva su historial); si no, se borra. */
  async remove(id: string): Promise<void> {
    const used = await this.admin.platformLeadSequenceEnrollment.count({
      where: { sequenceId: id },
    });
    if (used > 0) {
      await this.admin.platformLeadSequenceEnrollment.updateMany({
        where: { sequenceId: id, status: 'active' },
        data: { status: 'stopped', stopReason: 'manual', finishedAt: new Date(), nextRunAt: null },
      });
      const { count } = await this.admin.platformLeadSequence.updateMany({
        where: { id },
        data: { isActive: false, isDefault: false },
      });
      if (count === 0) this.notFound();
      return;
    }
    const { count } = await this.admin.platformLeadSequence.deleteMany({ where: { id } });
    if (count === 0) this.notFound();
  }

  private notFound(): never {
    throw new NotFoundException({ code: 'sequence_not_found', message: 'Secuencia no encontrada' });
  }

  // ------------------------------------------------------------ por lead

  async state(leadId: string): Promise<PlatformLeadSequenceStateDto | null> {
    const row = await this.admin.platformLeadSequenceEnrollment.findFirst({
      where: { leadId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: { sequence: { select: { name: true, steps: true } } },
    });
    if (!row) return null;
    return {
      enrollmentId: row.id,
      sequenceId: row.sequenceId,
      sequenceName: row.sequence.name,
      status: row.status as PlatformLeadSequenceStateDto['status'],
      sent: row.stepIndex,
      totalSteps: parseSteps(row.sequence.steps).length,
      nextRunAt: row.status === 'active' ? (row.nextRunAt?.toISOString() ?? null) : null,
      startedAt: row.startedAt.toISOString(),
      stopReason: row.stopReason,
    };
  }

  /**
   * Empieza una secuencia (la indicada o la de por defecto). A mano, un lead
   * que no puede recibirla da error; en automático simplemente no empieza.
   */
  async start(
    leadId: string,
    opts: { sequenceId?: string | null; byId: string | null; auto: boolean; now?: Date },
  ): Promise<boolean> {
    const now = opts.now ?? new Date();
    const fail = (code: string, message: string): false => {
      if (opts.auto) return false;
      throw new BadRequestException({ code, message });
    };
    const lead = await this.admin.platformLead.findUnique({
      where: { id: leadId },
      select: {
        status: true,
        email: true,
        discardedAt: true,
        sequenceOptOut: true,
        doNotContact: true,
      },
    });
    if (!lead || lead.discardedAt) return fail('lead_not_found', 'Lead no encontrado');
    if (lead.doNotContact) {
      return fail('do_not_contact', 'Pidió que no le volvamos a contactar');
    }
    if (!lead.email) return fail('lead_without_email', 'Este lead no tiene email');
    if (!OPEN_FOR_SEQUENCE.has(lead.status)) {
      return fail(
        'sequence_not_open',
        'Solo a leads nuevos, contactados o interesados (sin cuenta todavía)',
      );
    }
    if (opts.auto && lead.sequenceOptOut) return false;
    const sequence = opts.sequenceId
      ? await this.admin.platformLeadSequence.findFirst({
          where: { id: opts.sequenceId, isActive: true },
        })
      : await this.admin.platformLeadSequence.findFirst({
          where: { isDefault: true, isActive: true },
        });
    if (!sequence) return fail('sequence_not_found', 'No hay ninguna secuencia activa');
    const steps = parseSteps(sequence.steps);
    if (steps.length === 0) return fail('sequence_empty', 'La secuencia no tiene pasos');
    try {
      await this.admin.platformLeadSequenceEnrollment.create({
        data: {
          leadId,
          sequenceId: sequence.id,
          startedById: opts.byId,
          startedAt: now,
          nextRunAt: new Date(now.getTime() + steps[0]!.day * DAY),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (opts.auto) return false;
        throw new ConflictException({
          code: 'sequence_active',
          message: 'Ya tiene una secuencia en marcha',
        });
      }
      throw err;
    }
    if (!opts.auto) {
      await this.admin.platformLead.update({
        where: { id: leadId },
        data: { sequenceOptOut: false },
      });
    }
    return true;
  }

  /**
   * Con el primer correo o la propuesta empieza sola la de por defecto (si está
   * activado en los ajustes y el lead nunca tuvo una ni la desactivó).
   */
  async autoStart(leadId: string, byId: string | null): Promise<boolean> {
    const settings = await this.admin.platformLeadSettings.findFirst({
      select: { sequenceAutoStart: true },
    });
    if (settings && !settings.sequenceAutoStart) return false;
    const before = await this.admin.platformLeadSequenceEnrollment.count({ where: { leadId } });
    if (before > 0) return false;
    return this.start(leadId, { byId, auto: true });
  }

  /** Para la secuencia en marcha (si la hay). */
  async stop(leadId: string, reason: SequenceStopReason, now = new Date()): Promise<number> {
    const { count } = await this.admin.platformLeadSequenceEnrollment.updateMany({
      where: { leadId, status: 'active' },
      data: { status: 'stopped', stopReason: reason, finishedAt: now, nextRunAt: null },
    });
    return count;
  }

  // -------------------------------------------------------------- envío

  /** Por qué ya no hay que mandarle nada (o null si sigue). */
  private async stopReasonFor(
    e: { leadId: string; startedAt: Date },
    lead: {
      status: string;
      email: string | null;
      discardedAt: Date | null;
      sequenceOptOut: boolean;
      doNotContact: boolean;
      mergedIntoId: string | null;
    },
  ): Promise<SequenceStopReason | null> {
    if (lead.mergedIntoId) return 'merged';
    if (lead.discardedAt) return 'discarded';
    if (!OPEN_FOR_SEQUENCE.has(lead.status)) return 'stage';
    if (lead.sequenceOptOut || lead.doNotContact) return 'manual';
    if (!lead.email) return 'no_email';
    const replied = await this.admin.platformLeadActivity.count({
      where: {
        leadId: e.leadId,
        type: { in: [...PLATFORM_LEAD_REPLY_TYPES] },
        occurredAt: { gt: e.startedAt },
      },
    });
    return replied > 0 ? 'replied' : null;
  }

  /** Envía los pasos que tocan (cada 15 minutos desde el worker). */
  async runDue(now = new Date(), limit = 100): Promise<{ sent: number; stopped: number }> {
    const due = await this.admin.platformLeadSequenceEnrollment.findMany({
      where: { status: 'active', nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: limit,
      include: {
        sequence: true,
        lead: {
          select: {
            id: true,
            status: true,
            email: true,
            discardedAt: true,
            sequenceOptOut: true,
            doNotContact: true,
            mergedIntoId: true,
            companyName: true,
            contactName: true,
            units: true,
            city: true,
            assignedTo: { select: { fullName: true, email: true, isActive: true } },
          },
        },
      },
    });
    let sent = 0;
    let stopped = 0;
    for (const e of due) {
      const reason = e.sequence.isActive ? await this.stopReasonFor(e, e.lead) : 'manual';
      if (reason) {
        stopped += await this.stop(e.leadId, reason, now);
        continue;
      }
      const steps = parseSteps(e.sequence.steps);
      const step = steps[e.stepIndex];
      const next = steps[e.stepIndex + 1];
      // Se reserva el paso antes de enviarlo: si otra ejecución ya lo cogió, nada.
      const { count } = await this.admin.platformLeadSequenceEnrollment.updateMany({
        where: { id: e.id, status: 'active', stepIndex: e.stepIndex },
        data: step
          ? {
              stepIndex: e.stepIndex + 1,
              lastSentAt: now,
              nextRunAt: next ? new Date(e.startedAt.getTime() + next.day * DAY) : null,
              ...(next ? {} : { status: 'done', finishedAt: now, stopReason: 'finished' }),
            }
          : { status: 'done', finishedAt: now, stopReason: 'finished', nextRunAt: null },
      });
      if (count !== 1 || !step) continue;
      try {
        await this.sendStep(e.lead, step, e.sequence.name, e.stepIndex + 1, steps.length);
        sent += 1;
      } catch (err) {
        this.logger.warn(`[leads] secuencia ${e.id}, paso ${e.stepIndex + 1}: ${String(err)}`);
        await this.admin.platformLeadActivity.create({
          data: {
            leadId: e.leadId,
            type: 'system',
            content: `No se ha podido enviar el paso ${e.stepIndex + 1} de la secuencia «${e.sequence.name}»: ${
              err instanceof Error ? err.message : 'error desconocido'
            }`,
          },
        });
      }
    }
    return { sent, stopped };
  }

  private async sendStep(
    lead: {
      id: string;
      email: string | null;
      companyName: string | null;
      contactName: string | null;
      units: string | null;
      city: string | null;
      assignedTo: { fullName: string; email: string; isActive: boolean } | null;
    },
    step: PlatformLeadSequenceStep,
    sequenceName: string,
    position: number,
    total: number,
  ): Promise<void> {
    let subject = step.subject ?? '';
    let body = step.body ?? '';
    if (step.templateId) {
      const template = await this.admin.salesTemplate.findUnique({
        where: { id: step.templateId },
      });
      if (template?.isActive && template.channel === 'email') {
        subject = template.subject ?? subject;
        body = template.body;
      }
    }
    if (!subject || !body) throw new Error('el paso no tiene plantilla ni texto');
    const owner = lead.assignedTo?.isActive ? lead.assignedTo : null;
    const vars = { comercial: owner?.fullName ?? '', email_comercial: owner?.email ?? '' };
    const finalSubject = renderPlatformLeadTemplate(subject, lead, vars);
    const finalBody = renderPlatformLeadTemplate(body, lead, vars);
    await this.mail.send({
      leadId: lead.id,
      to: lead.email!,
      name: lead.contactName,
      subject: finalSubject,
      markdown: finalBody,
      sender: owner
        ? { fromName: owner.fullName, replyTo: { email: owner.email, name: owner.fullName } }
        : undefined,
    });
    await this.admin.platformLeadActivity.create({
      data: {
        leadId: lead.id,
        type: 'email_out',
        subject: finalSubject,
        content: `${finalBody}\n\n(Automático: secuencia «${sequenceName}», paso ${position} de ${total})`,
      },
    });
    this.logger.log(`[leads] secuencia: paso ${position} a ${platformLeadName(lead)}`);
  }
}
