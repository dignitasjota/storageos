import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { formatDateLong } from '../../common/format';
import { loadPuppeteer } from '../../common/puppeteer';
import { PrismaService } from '../database/prisma.service';

import { renderCashClosureHtml } from './cash-closure-template';
import { CashService } from './cash.service';

// Puppeteer 25+ es ESM only → dynamic import() para no romper Jest (CJS).
type Browser = import('puppeteer').Browser;

/** «11/11/2026, 20:15» en la hora del negocio. */
function dateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

/**
 * Cierre de caja en PDF, para imprimirlo y firmarlo. Se genera al pedirlo (no
 * se guarda): el cierre ya guarda el recuento y de dónde salía el esperado.
 */
@Injectable()
export class CashClosurePdfService implements OnModuleDestroy {
  private readonly logger = new Logger(CashClosurePdfService.name);
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cash: CashService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.browserPromise) {
      try {
        const b = await this.browserPromise;
        await b.close();
      } catch {
        // ignore
      }
    }
  }

  async render(
    tenantId: string,
    closureId: string,
    facilityScope: string[] | null,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const closure = await this.cash.getClosure(tenantId, closureId, facilityScope);
    const tenant = await this.prisma.withTenant(
      (tx) =>
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { name: true, timezone: true },
        }),
      tenantId,
    );
    const tz = tenant?.timezone ?? 'Europe/Madrid';
    const html = renderCashClosureHtml({
      businessName: tenant?.name ?? '',
      facilityName: closure.facilityName,
      // La columna es un día (DATE): se pinta tal cual, sin zona.
      dateLabel: formatDateLong(new Date(`${closure.date}T12:00:00Z`), 'UTC'),
      closedAtLabel: dateTime(closure.closedAt, tz),
      reopenedAtLabel: closure.reopenedAt ? dateTime(closure.reopenedAt, tz) : null,
      closure,
    });

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = Buffer.from(
        await page.pdf({
          format: 'A4',
          margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' },
          printBackground: true,
        }),
      );
      return { pdf, filename: `cierre-de-caja-${closure.date}.pdf` };
    } finally {
      await page.close();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) this.browserPromise = this.launchBrowser();
    try {
      const b = await this.browserPromise;
      if (b.connected) return b;
    } catch (err) {
      this.logger.warn(`Browser reset: ${(err as Error).message}`);
    }
    this.browserPromise = this.launchBrowser();
    return this.browserPromise;
  }

  private async launchBrowser(): Promise<Browser> {
    const puppeteer = await loadPuppeteer();
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
}
