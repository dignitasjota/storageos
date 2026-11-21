import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

/** Tope por pasada (la siguiente, a los 5 minutos, sigue con el resto). */
const BATCH = 200;

/**
 * Publica las entradas del blog programadas cuya hora ya llegó. Cada entrada
 * se reserva con un `updateMany` condicionado (sigue en borrador y con la misma
 * hora), así dos réplicas no la publican dos veces ni pisan un cambio del
 * equipo hecho mientras tanto.
 */
@Injectable()
export class BlogScheduleService {
  private readonly logger = new Logger(BlogScheduleService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
  ) {}

  async publishDue(now: Date = new Date()): Promise<{ published: number }> {
    const due = await this.admin.blogPost.findMany({
      where: { isPublished: false, publishAt: { not: null, lte: now } },
      select: { id: true, tenantId: true, title: true, slug: true, publishAt: true },
      orderBy: { publishAt: 'asc' },
      take: BATCH,
    });
    let published = 0;
    for (const post of due) {
      const publishAt = post.publishAt!;
      const { count } = await this.admin.blogPost.updateMany({
        where: { id: post.id, tenantId: post.tenantId, isPublished: false, publishAt },
        data: { isPublished: true, publishedAt: publishAt, publishAt: null },
      });
      if (count !== 1) continue;
      published += 1;
      await this.audit.write({
        tenantId: post.tenantId,
        userId: null,
        action: 'blog_post.published',
        entityType: 'BlogPost',
        entityId: post.id,
        changes: {
          title: post.title,
          slug: post.slug,
          isPublished: true,
          scheduled: true,
          publishAt: publishAt.toISOString(),
        },
      });
    }
    if (published > 0) this.logger.log(`[blog] ${published} entradas programadas publicadas`);
    return { published };
  }
}
