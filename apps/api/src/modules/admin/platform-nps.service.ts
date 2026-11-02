import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  npsScore,
  renderAdminEmail,
  type AnnouncementSegment,
  type CreateNpsSurveyInput,
  type NpsSurveyDetailDto,
  type NpsSurveyDto,
  type PublicNpsSurveyDto,
  type SubmitNpsResponseInput,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import { AdminSegmentService } from './admin-segment.service';

import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';

type SurveyRow = Prisma.PlatformNpsSurveyGetPayload<{
  include: { responses: { select: { score: true; respondedAt: true } } };
}>;

/**
 * Encuestas de satisfacción (NPS) del super admin a los propietarios de los
 * tenants. Cada destinatario recibe un enlace firmado (sin sesión) para
 * puntuar de 0 a 10 y dejar un comentario.
 */
@Injectable()
export class PlatformNpsService {
  private readonly key: Buffer;
  private readonly webBaseUrl: string;

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly segments: AdminSegmentService,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.key = createHash('sha256')
      .update(`platform-nps:v1:${config.get('MASTER_ENCRYPTION_KEY', { infer: true })}`)
      .digest();
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  // ── Panel admin ───────────────────────────────────────────────────────────

  async list(): Promise<NpsSurveyDto[]> {
    const rows = await this.admin.platformNpsSurvey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { responses: { select: { score: true, respondedAt: true } } },
    });
    return rows.map((r) => this.toDto(r));
  }

  async detail(id: string): Promise<NpsSurveyDetailDto> {
    const row = await this.findOrThrow(id);
    const answers = await this.admin.platformNpsResponse.findMany({
      where: { surveyId: id, respondedAt: { not: null } },
      orderBy: { respondedAt: 'desc' },
      include: { tenant: { select: { name: true } } },
    });
    return {
      ...this.toDto(row),
      answers: answers.map((a) => ({
        id: a.id,
        tenantId: a.tenantId,
        tenantName: a.tenant.name,
        email: a.email,
        score: a.score ?? 0,
        comment: a.comment,
        respondedAt: a.respondedAt!.toISOString(),
      })),
    };
  }

  async create(input: CreateNpsSurveyInput, superAdminId: string): Promise<NpsSurveyDto> {
    const row = await this.admin.platformNpsSurvey.create({
      data: {
        name: input.name,
        question: input.question,
        segment: input.segment as unknown as Prisma.InputJsonValue,
        createdById: superAdminId,
      },
      include: { responses: { select: { score: true, respondedAt: true } } },
    });
    return this.toDto(row);
  }

  /** Envía la encuesta a los propietarios del público (una vez por usuario). */
  async send(id: string): Promise<NpsSurveyDto> {
    const survey = await this.findOrThrow(id);
    if (survey.status !== 'draft') {
      throw new BadRequestException({
        code: 'survey_already_sent',
        message: 'La encuesta ya se envió.',
      });
    }
    const claimed = await this.admin.platformNpsSurvey.updateMany({
      where: { id, status: 'draft' },
      data: { status: 'sent', sentAt: new Date() },
    });
    if (claimed.count === 0) return this.toDto(await this.findOrThrow(id));

    const tenants = await this.segments.tenantsFor(
      survey.segment as unknown as AnnouncementSegment,
    );
    const recipients = (await this.segments.recipientsFor(tenants, false)).filter(
      (r) => r.userId != null,
    );
    const jobs: { name: string; data: Record<string, unknown> }[] = [];
    for (const r of recipients) {
      const resp = await this.admin.platformNpsResponse.upsert({
        where: { surveyId_userId: { surveyId: id, userId: r.userId! } },
        create: { surveyId: id, tenantId: r.tenantId, userId: r.userId, email: r.email },
        update: {},
        select: { id: true },
      });
      const url = `${this.webBaseUrl}/nps/${this.token(resp.id)}`;
      const name = r.fullName?.trim().split(/\s+/)[0];
      const body = [
        `Hola${name ? `, ${name}` : ''}:`,
        '',
        survey.question,
        '',
        'Contestar es un clic y nos ayuda mucho a mejorar TrasterOS:',
        '',
        `[[boton: Contestar la encuesta | ${url}]]`,
        '',
        'Gracias,',
        'El equipo de TrasterOS',
      ].join('\n');
      jobs.push({
        name: JOB_EMAIL_SEND,
        data: {
          to: r.email,
          kind: 'admin_message',
          subject: '¿Qué tal te va con TrasterOS?',
          ...renderAdminEmail(body),
        },
      });
    }
    if (jobs.length > 0) await this.emailQueue.addBulk(jobs);
    return this.toDto(await this.findOrThrow(id));
  }

  async close(id: string): Promise<NpsSurveyDto> {
    await this.findOrThrow(id);
    await this.admin.platformNpsSurvey.update({ where: { id }, data: { status: 'closed' } });
    return this.toDto(await this.findOrThrow(id));
  }

  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    await this.admin.platformNpsSurvey.delete({ where: { id } });
  }

  // ── Público (enlace del correo) ───────────────────────────────────────────

  async publicGet(token: string): Promise<PublicNpsSurveyDto> {
    const resp = await this.resolve(token);
    return {
      question: resp.survey.question,
      tenantName: resp.tenant.name,
      answered: resp.respondedAt != null,
      score: resp.score,
      closed: resp.survey.status === 'closed',
    };
  }

  async publicSubmit(token: string, input: SubmitNpsResponseInput): Promise<PublicNpsSurveyDto> {
    const resp = await this.resolve(token);
    if (resp.survey.status === 'closed') {
      throw new BadRequestException({
        code: 'survey_closed',
        message: 'La encuesta ya está cerrada.',
      });
    }
    // Se puede corregir la respuesta mientras la encuesta siga abierta.
    await this.admin.platformNpsResponse.update({
      where: { id: resp.id },
      data: { score: input.score, comment: input.comment?.trim() || null, respondedAt: new Date() },
    });
    return this.publicGet(token);
  }

  // ── Ayudantes ─────────────────────────────────────────────────────────────

  token(responseId: string): string {
    const sig = createHmac('sha256', this.key).update(responseId).digest('base64url');
    return `${responseId}.${sig}`;
  }

  private async resolve(token: string) {
    const notFound = new NotFoundException({
      code: 'survey_not_found',
      message: 'Este enlace no es válido.',
    });
    const [id, sig, ...rest] = token.split('.');
    if (rest.length > 0 || !id || !sig || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound;
    const expected = Buffer.from(this.token(id).split('.')[1] ?? '');
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw notFound;
    const resp = await this.admin.platformNpsResponse.findUnique({
      where: { id },
      include: {
        survey: { select: { question: true, status: true } },
        tenant: { select: { name: true } },
      },
    });
    if (!resp) throw notFound;
    return resp;
  }

  private async findOrThrow(id: string): Promise<SurveyRow> {
    const row = await this.admin.platformNpsSurvey.findUnique({
      where: { id },
      include: { responses: { select: { score: true, respondedAt: true } } },
    });
    if (!row) {
      throw new NotFoundException({ code: 'survey_not_found', message: 'Encuesta no encontrada' });
    }
    return row;
  }

  private toDto(r: SurveyRow): NpsSurveyDto {
    const scores = r.responses
      .filter((x) => x.respondedAt != null && x.score != null)
      .map((x) => x.score as number);
    return {
      id: r.id,
      name: r.name,
      question: r.question,
      segment: r.segment as unknown as AnnouncementSegment,
      status: r.status as NpsSurveyDto['status'],
      sentAt: r.sentAt?.toISOString() ?? null,
      sent: r.responses.length,
      responses: scores.length,
      nps: npsScore(scores),
      promoters: scores.filter((s) => s >= 9).length,
      passives: scores.filter((s) => s >= 7 && s <= 8).length,
      detractors: scores.filter((s) => s <= 6).length,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
