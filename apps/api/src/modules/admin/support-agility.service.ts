import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type {
  AdminSupportStatsDto,
  SupportCannedResponseDto,
  UpsertSupportCannedResponseInput,
} from '@storageos/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Soporte más ágil: respuestas guardadas para las preguntas frecuentes y
 * tiempos de primera respuesta de los tickets.
 */
@Injectable()
export class SupportAgilityService {
  constructor(private readonly admin: PrismaAdminService) {}

  async listCanned(): Promise<SupportCannedResponseDto[]> {
    const rows = await this.admin.supportCannedResponse.findMany({
      orderBy: { title: 'asc' },
      include: { createdBy: { select: { fullName: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      authorName: r.createdBy?.fullName ?? null,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async createCanned(
    input: UpsertSupportCannedResponseInput,
    superAdminId: string,
  ): Promise<SupportCannedResponseDto> {
    const row = await this.admin.supportCannedResponse.create({
      data: { title: input.title, body: input.body, createdById: superAdminId },
    });
    return (await this.listCanned()).find((r) => r.id === row.id)!;
  }

  async updateCanned(
    id: string,
    input: UpsertSupportCannedResponseInput,
  ): Promise<SupportCannedResponseDto> {
    const updated = await this.admin.supportCannedResponse.updateMany({
      where: { id },
      data: { title: input.title, body: input.body },
    });
    if (updated.count === 0) throw new NotFoundException({ code: 'canned_response_not_found' });
    return (await this.listCanned()).find((r) => r.id === id)!;
  }

  async removeCanned(id: string): Promise<void> {
    const deleted = await this.admin.supportCannedResponse.deleteMany({ where: { id } });
    if (deleted.count === 0) throw new NotFoundException({ code: 'canned_response_not_found' });
  }

  async stats(days = 30, now = new Date()): Promise<AdminSupportStatsDto> {
    const period = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
    const since = new Date(now.getTime() - period * DAY_MS);
    const [opened, awaiting] = await Promise.all([
      this.admin.supportTicket.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true, firstResponseAt: true },
      }),
      this.admin.supportTicket.findMany({
        where: { firstResponseAt: null, status: { notIn: ['resolved', 'closed'] } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const minutes = opened
      .filter((t) => t.firstResponseAt)
      .map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / 60_000)
      .sort((a, b) => a - b);
    const avg = minutes.length ? minutes.reduce((a, b) => a + b, 0) / minutes.length : null;
    const median = minutes.length
      ? minutes.length % 2
        ? minutes[(minutes.length - 1) / 2]!
        : (minutes[minutes.length / 2 - 1]! + minutes[minutes.length / 2]!) / 2
      : null;
    const withinDay = minutes.filter((m) => m <= 24 * 60).length;
    const oldest = awaiting[0];
    return {
      days: period,
      ticketsOpened: opened.length,
      ticketsAnswered: minutes.length,
      avgFirstResponseMinutes: avg === null ? null : Math.round(avg),
      medianFirstResponseMinutes: median === null ? null : Math.round(median),
      answeredWithinDayPct: minutes.length ? Math.round((withinDay / minutes.length) * 100) : null,
      awaitingFirstResponse: awaiting.length,
      oldestAwaitingHours: oldest
        ? Math.round((now.getTime() - oldest.createdAt.getTime()) / 3_600_000)
        : null,
    };
  }
}
