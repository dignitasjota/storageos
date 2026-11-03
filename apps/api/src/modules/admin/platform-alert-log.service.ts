import { Injectable, Logger } from '@nestjs/common';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { PlatformAlertLogDto } from '@storageos/shared';

type Channel = PlatformAlertLogDto['channel'];

/** Historial de los avisos al administrador (email y chat). */
@Injectable()
export class PlatformAlertLogService {
  private readonly logger = new Logger(PlatformAlertLogService.name);

  constructor(private readonly admin: PrismaAdminService) {}

  /** Best-effort: un fallo al anotar nunca rompe el envío. */
  async record(args: {
    channel: Channel;
    kind: string;
    ok: boolean;
    summary: string;
    error?: string | null;
  }): Promise<void> {
    try {
      await this.admin.platformAlertLog.create({
        data: {
          channel: args.channel,
          kind: args.kind,
          ok: args.ok,
          summary: args.summary.slice(0, 500),
          error: args.error?.slice(0, 500) ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`No se pudo anotar el aviso: ${err instanceof Error ? err.message : err}`);
    }
  }

  async list(limit = 100): Promise<PlatformAlertLogDto[]> {
    const rows = await this.admin.platformAlertLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel as Channel,
      kind: r.kind,
      ok: r.ok,
      error: r.error,
      summary: r.summary,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
