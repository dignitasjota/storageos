import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SeoCrawlerService } from '../crawler/seo-crawler.service';
import { SEO_DOMAIN_CONNECTED, type SeoDomainConnectedEvent } from '../seo-projects.service';
import { SeoPageSpeedService } from '../technical/seo-pagespeed.service';

/**
 * Arranque automático en un tenant (mejora 9): al conectar su dominio principal
 * con Search Console, lanza un primer rastreo y una medición de velocidad de la
 * portada y deja encendido un rastreo mensual, para que «Técnico», el enlazado
 * interno y el informe no nazcan vacíos. Respeta los topes de siempre (un
 * rastreo vivo por proyecto, la cola propia de PageSpeed y su tope diario) y
 * nunca rompe la conexión del dominio: cualquier fallo solo se apunta en el log.
 */
@Injectable()
export class SeoAutoStartService {
  private readonly logger = new Logger(SeoAutoStartService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly crawler: SeoCrawlerService,
    private readonly pagespeed: SeoPageSpeedService,
  ) {}

  @OnEvent(SEO_DOMAIN_CONNECTED, { async: true })
  async onConnected(event: SeoDomainConnectedEvent): Promise<void> {
    if (process.env.SEO_AUTO_START === 'off') return;
    try {
      await this.start(event.tenantId, event.projectId);
    } catch (err) {
      this.logger.warn(
        `Arranque automático de SEO (${event.projectId}): ${(err as Error).message}`,
      );
    }
  }

  /** Devuelve qué ha arrancado (para los tests). */
  async start(
    tenantId: string,
    projectId: string,
  ): Promise<{ crawl: boolean; pagespeed: boolean; monthly: boolean }> {
    const result = { crawl: false, pagespeed: false, monthly: false };
    const project = await this.admin.seoProject.findFirst({
      where: { id: projectId, tenantId, status: 'active' },
      select: { id: true, crawlSettings: true },
    });
    if (!project) return result;
    // Solo la primera vez: si ya hubo un rastreo (a mano o programado), no se toca nada.
    const crawls = await this.admin.seoCrawl.count({ where: { projectId } });
    if (crawls > 0) return result;

    let startUrl: string | null = null;
    try {
      const res = await this.crawler.start(undefined, projectId, {}, 'scheduled');
      result.crawl = !res.alreadyRunning;
      startUrl = res.crawl.startUrl;
    } catch (err) {
      this.logger.warn(`Primer rastreo (${projectId}): ${(err as Error).message}`);
    }
    if (startUrl) {
      try {
        await this.pagespeed.run(tenantId, projectId, { url: startUrl }, {});
        result.pagespeed = true;
      } catch (err) {
        this.logger.warn(`Primera medición de velocidad (${projectId}): ${(err as Error).message}`);
      }
    }
    // Rastreo mensual encendido, sin pisar lo que el tenant ya hubiera decidido.
    const stored = (project.crawlSettings ?? {}) as Record<string, unknown>;
    if (stored.weeklyEnabled === undefined) {
      await this.admin.seoProject.update({
        where: { id: projectId },
        data: { crawlSettings: { ...stored, weeklyEnabled: true, intervalWeeks: 4 } },
      });
      result.monthly = true;
    }
    return result;
  }
}
