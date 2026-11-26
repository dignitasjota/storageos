import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SeoCrawlerService } from './seo-crawler.service';

/**
 * Rastreo semanal (PR 10): cada hora se mira qué proyectos tienen su rastreo
 * en este día y hora (España); y, al arrancar el proceso que ejecuta la cola,
 * lo que quedó en cola o a medias vuelve a ella (sigue donde iba). Dos
 * réplicas no lanzan dos rastreos: solo puede haber uno vivo por proyecto.
 */
@Injectable()
export class SeoCrawlCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeoCrawlCron.name);

  constructor(private readonly crawler: SeoCrawlerService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await this.crawler.resumePending();
      if (n > 0) this.logger.log(`SEO: ${n} rastreo(s) pendiente(s) vuelven a la cola`);
    } catch (err) {
      this.logger.error(`SEO: no se pudieron reanudar los rastreos: ${(err as Error).message}`);
    }
  }

  @Cron('5 * * * *', { name: 'seo.crawl-weekly', timeZone: 'Europe/Madrid' })
  async weekly(): Promise<void> {
    try {
      const n = await this.crawler.scheduleDue();
      if (n > 0) this.logger.log(`SEO: ${n} rastreo(s) semanal(es) en la cola`);
    } catch (err) {
      this.logger.error(`Rastreo semanal SEO: ${(err as Error).message}`);
    }
  }
}
