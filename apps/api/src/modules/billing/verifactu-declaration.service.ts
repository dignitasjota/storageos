import { Injectable, NotFoundException } from '@nestjs/common';
import { verifactuDeclaration } from '@storageos/shared';

import { loadPuppeteer } from '../../common/puppeteer';

import { renderDeclarationHtml } from './verifactu-declaration-template';

import type { VerifactuDeclarationDto } from '@storageos/shared';

/**
 * PDF de la declaración responsable del sistema (art. 15.3 de la Orden
 * HAC/1177/2024: el cliente la recibe en un formato electrónico de uso amplio).
 * El texto es fijo por versión: se genera una vez y se guarda en memoria.
 */
@Injectable()
export class VerifactuDeclarationService {
  private readonly cache = new Map<string, Promise<Buffer>>();

  async pdf(version?: string): Promise<{ buffer: Buffer; filename: string }> {
    const doc = verifactuDeclaration(version || undefined);
    if (!doc) {
      throw new NotFoundException({
        code: 'declaration_not_found',
        message: 'No hay declaración responsable de esa versión',
      });
    }
    let pending = this.cache.get(doc.version);
    if (!pending) {
      pending = this.render(doc);
      this.cache.set(doc.version, pending);
      // Si falla, se vuelve a intentar en la siguiente petición.
      pending.catch(() => this.cache.delete(doc.version));
    }
    return {
      buffer: await pending,
      filename: `declaracion-responsable-trasteros-${doc.version}.pdf`,
    };
  }

  private async render(doc: VerifactuDeclarationDto): Promise<Buffer> {
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(renderDeclarationHtml(doc), { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}
