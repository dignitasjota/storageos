import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { AdminCommsService } from './admin-comms.service';
import { AdminSegmentService } from './admin-segment.service';

import type { Prisma } from '@storageos/database';
import type {
  AdminBroadcastResultDto,
  AnnouncementPreviewDto,
  AnnouncementPreviewInput,
  AnnouncementSegment,
  PlatformAnnouncementDto,
  PlatformAnnouncementStatus,
  SavePlatformAnnouncementInput,
} from '@storageos/shared';

interface ActionMeta {
  superAdminId: string;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

type AnnouncementRow = Prisma.PlatformAnnouncementGetPayload<{
  include: { createdBy: { select: { fullName: true } } };
}>;

/**
 * Historial de anuncios del panel admin: borradores, programados y enviados,
 * con lo que ha llegado y rebotado de cada uno (del historial de correos).
 */
@Injectable()
export class PlatformAnnouncementsService {
  private readonly logger = new Logger(PlatformAnnouncementsService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly comms: AdminCommsService,
    private readonly segments: AdminSegmentService,
  ) {}

  async list(): Promise<PlatformAnnouncementDto[]> {
    const rows = await this.admin.platformAnnouncement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { createdBy: { select: { fullName: true } } },
    });
    const stats = await this.statsFor(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, stats.get(r.id)));
  }

  async get(id: string): Promise<PlatformAnnouncementDto> {
    const row = await this.findOrThrow(id);
    const stats = await this.statsFor([id]);
    return this.toDto(row, stats.get(id));
  }

  async create(input: SavePlatformAnnouncementInput, superAdminId: string) {
    const row = await this.admin.platformAnnouncement.create({
      data: { ...this.fields(input), createdById: superAdminId },
      include: { createdBy: { select: { fullName: true } } },
    });
    return this.toDto(row);
  }

  /** Solo los borradores y los programados se editan. */
  async update(id: string, input: SavePlatformAnnouncementInput) {
    const row = await this.findOrThrow(id);
    this.assertEditable(row.status);
    const updated = await this.admin.platformAnnouncement.update({
      where: { id },
      data: this.fields(input),
      include: { createdBy: { select: { fullName: true } } },
    });
    return this.toDto(updated);
  }

  async remove(id: string): Promise<void> {
    const row = await this.findOrThrow(id);
    if (row.status !== 'draft' && row.status !== 'cancelled') {
      throw new BadRequestException({
        code: 'announcement_not_deletable',
        message: 'Solo se borran los borradores y los cancelados.',
      });
    }
    await this.admin.platformAnnouncement.delete({ where: { id } });
  }

  async duplicate(id: string, superAdminId: string) {
    const row = await this.findOrThrow(id);
    const copy = await this.admin.platformAnnouncement.create({
      data: {
        subject: row.subject,
        body: row.body,
        segment: row.segment as Prisma.InputJsonValue,
        commercial: row.commercial,
        createdById: superAdminId,
      },
      include: { createdBy: { select: { fullName: true } } },
    });
    return this.toDto(copy);
  }

  /** Cuántos tenants y correos alcanzaría (sin enviar). */
  async preview(input: AnnouncementPreviewInput): Promise<AnnouncementPreviewDto> {
    const tenants = await this.segments.tenantsFor(input.segment);
    const recipients = await this.segments.recipientsFor(tenants, input.commercial);
    const reached = new Set(recipients.filter((r) => !r.optedOut).map((r) => r.tenantId));
    return {
      tenants: reached.size,
      recipients: recipients.filter((r) => !r.optedOut).length,
      optedOut: recipients.filter((r) => r.optedOut).length,
      sample: tenants
        .filter((t) => reached.has(t.id))
        .slice(0, 10)
        .map((t) => t.name),
    };
  }

  /** Enviar ya (sin fecha) o programarlo. */
  async send(id: string, scheduledFor: string | null, meta: ActionMeta) {
    const row = await this.findOrThrow(id);
    this.assertEditable(row.status);
    if (scheduledFor) {
      const at = new Date(scheduledFor);
      if (at.getTime() <= Date.now() + 60_000) {
        throw new BadRequestException({
          code: 'invalid_schedule',
          message: 'La fecha de envío debe ser posterior a ahora.',
        });
      }
      await this.admin.platformAnnouncement.update({
        where: { id },
        data: { status: 'scheduled', scheduledFor: at },
      });
      return this.get(id);
    }
    await this.claimAndDeliver(id, row.status, meta);
    return this.get(id);
  }

  async cancel(id: string) {
    const row = await this.findOrThrow(id);
    if (row.status !== 'scheduled') {
      throw new BadRequestException({
        code: 'announcement_not_scheduled',
        message: 'Solo se cancela un anuncio programado.',
      });
    }
    await this.admin.platformAnnouncement.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    return this.get(id);
  }

  /**
   * Reenvía a quien no lo recibió: los correos fallidos (no los rebotes, que
   * están bloqueados) y los destinatarios del público que no tienen correo de
   * este anuncio.
   */
  async resendMissing(id: string, meta: ActionMeta): Promise<AdminBroadcastResultDto> {
    const row = await this.findOrThrow(id);
    if (row.status !== 'sent') {
      throw new BadRequestException({
        code: 'announcement_not_sent',
        message: 'El anuncio aún no se ha enviado.',
      });
    }
    const logs = await this.admin.platformEmailLog.findMany({
      where: { announcementId: id },
      select: { recipient: true, status: true },
    });
    const ok = new Set(logs.filter((l) => l.status !== 'failed').map((l) => l.recipient));
    const tenants = await this.segments.tenantsFor(row.segment as unknown as AnnouncementSegment);
    const recipients = await this.segments.recipientsFor(tenants, row.commercial);
    const missing = new Set(recipients.filter((r) => !ok.has(r.email)).map((r) => r.email));
    if (missing.size === 0) {
      return { tenants: 0, recipients: 0, failed: 0, skipped: 0, optedOut: 0 };
    }
    return this.comms.deliverAnnouncement(id, meta, missing);
  }

  /** Programados cuya hora ha llegado (cada 5 minutos). */
  @Cron('*/5 * * * *', { name: 'admin.announcements-scheduled' })
  async handleScheduled(): Promise<void> {
    try {
      await this.runScheduled();
    } catch (err) {
      this.logger.error(`[announcements] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runScheduled(now = new Date()): Promise<number> {
    const due = await this.admin.platformAnnouncement.findMany({
      where: { status: 'scheduled', scheduledFor: { lte: now } },
      select: { id: true, createdById: true },
    });
    let sent = 0;
    for (const a of due) {
      try {
        if (await this.claimAndDeliver(a.id, 'scheduled', { superAdminId: a.createdById ?? '' })) {
          sent += 1;
        }
      } catch (err) {
        this.logger.error(
          `[announcements] ${a.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent;
  }

  /** Reserva el anuncio (sin doble envío entre réplicas o dobles clics) y lo envía. */
  private async claimAndDeliver(id: string, from: string, meta: ActionMeta): Promise<boolean> {
    const claimed = await this.admin.platformAnnouncement.updateMany({
      where: { id, status: from },
      data: { status: 'sending' },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'announcement_busy',
        message: 'Este anuncio ya se está enviando.',
      });
    }
    try {
      await this.comms.deliverAnnouncement(id, meta);
      return true;
    } catch (err) {
      await this.admin.platformAnnouncement.updateMany({
        where: { id, status: 'sending' },
        data: { status: from },
      });
      throw err;
    }
  }

  private assertEditable(status: string): void {
    if (status !== 'draft' && status !== 'scheduled') {
      throw new BadRequestException({
        code: 'announcement_not_editable',
        message: 'Un anuncio enviado no se puede cambiar; duplícalo.',
      });
    }
  }

  private async findOrThrow(id: string): Promise<AnnouncementRow> {
    const row = await this.admin.platformAnnouncement.findUnique({
      where: { id },
      include: { createdBy: { select: { fullName: true } } },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'announcement_not_found',
        message: 'Anuncio no encontrado',
      });
    }
    return row;
  }

  private fields(input: SavePlatformAnnouncementInput) {
    return {
      subject: input.subject,
      body: input.body,
      segment: input.segment as unknown as Prisma.InputJsonValue,
      commercial: input.commercial,
    };
  }

  private async statsFor(
    ids: string[],
  ): Promise<Map<string, { delivered: number; bounced: number; failed: number }>> {
    const out = new Map<string, { delivered: number; bounced: number; failed: number }>();
    if (ids.length === 0) return out;
    const groups = await this.admin.platformEmailLog.groupBy({
      by: ['announcementId', 'status'],
      where: { announcementId: { in: ids } },
      _count: { _all: true },
    });
    for (const g of groups) {
      if (!g.announcementId) continue;
      const cur = out.get(g.announcementId) ?? { delivered: 0, bounced: 0, failed: 0 };
      if (g.status === 'delivered') cur.delivered += g._count._all;
      else if (g.status === 'bounced') cur.bounced += g._count._all;
      else if (g.status === 'failed' || g.status === 'suppressed') cur.failed += g._count._all;
      out.set(g.announcementId, cur);
    }
    return out;
  }

  private toDto(
    r: AnnouncementRow,
    s: { delivered: number; bounced: number; failed: number } = {
      delivered: 0,
      bounced: 0,
      failed: 0,
    },
  ): PlatformAnnouncementDto {
    return {
      id: r.id,
      subject: r.subject,
      body: r.body,
      segment: r.segment as unknown as AnnouncementSegment,
      commercial: r.commercial,
      status: r.status as PlatformAnnouncementStatus,
      scheduledFor: r.scheduledFor?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      tenantsCount: r.tenantsCount,
      recipientsCount: r.recipientsCount,
      optedOutCount: r.optedOutCount,
      ...s,
      createdByName: r.createdBy?.fullName ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
