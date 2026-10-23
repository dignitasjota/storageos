import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { loadPuppeteer } from '../puppeteer';

type Browser = import('puppeteer').Browser;

/**
 * Convierte el HTML del mandato firmado en PDF (Puppeteer, como los contratos).
 * Se genera al descargarlo: la constancia vive en la base de datos.
 */
@Injectable()
export class SepaMandatePdfService implements OnModuleDestroy {
  private readonly logger = new Logger(SepaMandatePdfService.name);
  private browserPromise: Promise<Browser> | null = null;

  async render(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      return Buffer.from(pdf);
    } finally {
      await page.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.browserPromise) return;
    try {
      const b = await this.browserPromise;
      await b.close();
    } catch {
      /* ya cerrado */
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) this.browserPromise = this.launch();
    try {
      const b = await this.browserPromise;
      if (b.connected) return b;
    } catch (err) {
      this.logger.warn(`Browser reset: ${(err as Error).message}`);
    }
    this.browserPromise = this.launch();
    return this.browserPromise;
  }

  private async launch(): Promise<Browser> {
    const puppeteer = await loadPuppeteer();
    return puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
}
