import { createHash } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PRODUCT_UPDATE_CATEGORY_LABELS,
  adminMessageText,
  platformEmailShell,
  productUpdateTargets,
  resolveStaffEmailSettings,
  resolveUserEmailNotices,
  type ProductUpdateCategory,
  type ProductUpdatesDigestResultDto,
  type ProductUpdatesDigestUnsubscribeDto,
} from '@storageos/shared';
import { Queue } from 'bullmq';

import { currentMonth, zonedDayStart } from '../../common/format';
import {
  buildUnsubscribeToken,
  maskEmail,
  parseUnsubscribeToken,
} from '../../common/marketing/unsubscribe-token';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { JOB_EMAIL_SEND, QUEUE_EMAIL } from '../queues/queue-names';

import type { Env } from '../../config/env.schema';

/** Tipo del aviso en `users.email_notice_prefs` (baja desde el perfil). */
const NOTICE_KIND = 'product_updates_digest';
/** Usuarios por tanda al recorrerlos. */
const BATCH = 500;
/** Novedades que se listan como mucho en un correo. */
const MAX_ITEMS = 12;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Primeras frases del texto en Markdown, sin marcas. */
function excerpt(markdown: string, max = 220): string {
  const plain = adminMessageText(markdown).replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Mes anterior al de `now` en hora de Madrid: clave AAAA-MM y su intervalo. */
export function previousMonthWindow(now: Date): {
  key: string;
  label: string;
  start: Date;
  end: Date;
} {
  const current = currentMonth(now);
  const [y, m] = current.key.split('-').map(Number) as [number, number];
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const key = `${prevY}-${String(prevM).padStart(2, '0')}`;
  const label = new Date(Date.UTC(prevY, prevM - 1, 1)).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return { key, label, start: zonedDayStart(`${key}-01`), end: current.start };
}

/**
 * Resumen mensual de «Novedades» por correo: el día 2 de cada mes, a cada
 * usuario activo y verificado, con lo publicado el mes anterior que le toca
 * (por su plan y su rol). Cada uno se da de baja desde su perfil (Avisos) o
 * con el enlace del propio correo. Una reserva por usuario y mes
 * (`users.product_updates_digest_month`) evita duplicados entre réplicas.
 */
@Injectable()
export class ProductUpdatesDigestService {
  private readonly logger = new Logger(ProductUpdatesDigestService.name);
  private readonly webBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly tokenKey: Buffer;

  constructor(
    private readonly admin: PrismaAdminService,
    config: ConfigService<Env, true>,
    @InjectQueue(QUEUE_EMAIL) private readonly emailQueue: Queue,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.apiBaseUrl = config.get('API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    // Clave propia: un enlace de baja de este resumen no sirve para otras bajas.
    this.tokenKey = createHash('sha256')
      .update(`product-updates-digest:v1:${config.get('MASTER_ENCRYPTION_KEY', { infer: true })}`)
      .digest();
  }

  unsubscribeToken(userId: string): string {
    return buildUnsubscribeToken(this.tokenKey, 'u', userId);
  }

  /** Envía el resumen del mes anterior a `now` (por defecto, ahora). */
  async sendMonthly(now = new Date()): Promise<ProductUpdatesDigestResultDto> {
    const window = previousMonthWindow(now);
    const updates = await this.admin.productUpdate.findMany({
      where: { publishedAt: { gte: window.start, lt: window.end, lte: now } },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        body: true,
        category: true,
        targetPlans: true,
        targetRoles: true,
      },
    });
    const result: ProductUpdatesDigestResultDto = {
      month: window.key,
      updates: updates.length,
      sent: 0,
    };
    if (updates.length === 0) return result;

    let cursor: string | undefined;
    for (;;) {
      const users = await this.admin.user.findMany({
        where: {
          isActive: true,
          emailVerifiedAt: { not: null },
          OR: [
            { productUpdatesDigestMonth: null },
            { productUpdatesDigestMonth: { not: window.key } },
          ],
          tenant: { deletedAt: null, status: { in: ['active', 'trial'] } },
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          emailNoticePrefs: true,
          tenant: {
            select: {
              staffEmailSettings: true,
              subscription: { select: { plan: { select: { slug: true } } } },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (users.length === 0) break;
      cursor = users[users.length - 1]!.id;

      for (const u of users) {
        if (!resolveUserEmailNotices(u.emailNoticePrefs, u.role)[NOTICE_KIND]) continue;
        if (!resolveStaffEmailSettings(u.tenant.staffEmailSettings)[NOTICE_KIND]) continue;
        const planSlug = u.tenant.subscription?.plan.slug ?? null;
        const mine = updates.filter((up) => productUpdateTargets(up, planSlug, u.role));
        if (mine.length === 0) continue;
        // Reserva del usuario para este mes: solo una réplica lo envía.
        const claimed = await this.admin.user.updateMany({
          where: {
            id: u.id,
            OR: [
              { productUpdatesDigestMonth: null },
              { productUpdatesDigestMonth: { not: window.key } },
            ],
          },
          data: { productUpdatesDigestMonth: window.key },
        });
        if (claimed.count === 0) continue;
        try {
          await this.emailQueue.add(JOB_EMAIL_SEND, this.render(u, mine, window.label));
          result.sent += 1;
        } catch (err) {
          // Sin encolar: se libera la reserva para el siguiente intento.
          await this.admin.user
            .updateMany({
              where: { id: u.id, productUpdatesDigestMonth: window.key },
              data: { productUpdatesDigestMonth: null },
            })
            .catch(() => undefined);
          this.logger.warn(
            `Resumen de novedades para ${u.id} sin encolar: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (users.length < BATCH) break;
    }
    return result;
  }

  private render(
    user: { id: string; email: string; fullName: string },
    updates: Array<{ id: string; title: string; body: string; category: string }>,
    monthLabel: string,
  ) {
    const updatesUrl = `${this.webBaseUrl}/updates`;
    const token = this.unsubscribeToken(user.id);
    const unsubscribeUrl = `${this.webBaseUrl}/baja-novedades/${encodeURIComponent(token)}`;
    const oneClick = `${this.apiBaseUrl}/v1/public/product-updates-digest/unsubscribe/${encodeURIComponent(token)}`;
    const shown = updates.slice(0, MAX_ITEMS);
    const more = updates.length - shown.length;
    const firstName = user.fullName.trim().split(/\s+/)[0] ?? '';
    const greeting = firstName ? `Hola, ${firstName}:` : 'Hola:';
    const intro = `Esto es lo que añadimos y mejoramos en TrasterOS en ${monthLabel}.`;
    const items = shown
      .map((up) => {
        const kind =
          PRODUCT_UPDATE_CATEGORY_LABELS[up.category as ProductUpdateCategory] ?? up.category;
        return `<tr><td style="padding:12px 0;border-bottom:1px solid #e2e8f0">
<p style="margin:0 0 4px;font-size:12px;color:#64748b">${esc(kind)}</p>
<p style="margin:0 0 4px;font-weight:600">${esc(up.title)}</p>
<p style="margin:0;color:#475569">${esc(excerpt(up.body))}</p></td></tr>`;
      })
      .join('');
    const html = platformEmailShell(
      `<p style="margin:0 0 12px">${esc(greeting)}</p>
<p style="margin:0 0 16px">${esc(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
${more > 0 ? `<p style="margin:12px 0 0;color:#475569">Y ${more} más.</p>` : ''}
<p style="margin:24px 0 0"><a href="${esc(updatesUrl)}" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Ver todas las novedades</a></p>`,
      `Recibes este resumen una vez al mes. Puedes quitarlo en tu perfil (Avisos) o <a href="${esc(unsubscribeUrl)}" style="color:#64748b">darte de baja aquí</a>.<br>`,
    );
    const text = [
      greeting,
      '',
      intro,
      '',
      ...shown.map(
        (up) =>
          `- ${up.title} (${PRODUCT_UPDATE_CATEGORY_LABELS[up.category as ProductUpdateCategory] ?? up.category}): ${excerpt(up.body)}`,
      ),
      ...(more > 0 ? [`Y ${more} más.`] : []),
      '',
      `Ver todas las novedades: ${updatesUrl}`,
      '',
      '—',
      `Darte de baja de este resumen: ${unsubscribeUrl}`,
    ].join('\n');
    return {
      to: user.email,
      kind: 'product_updates_digest',
      subject: `Novedades de TrasterOS en ${monthLabel}`,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<${oneClick}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  // --- Baja desde el enlace del correo ---

  private async userFromToken(token: string): Promise<{
    id: string;
    email: string;
    role: string;
    emailNoticePrefs: unknown;
  }> {
    const parsed = parseUnsubscribeToken(this.tokenKey, token);
    if (!parsed || parsed.kind !== 'u') {
      throw new NotFoundException({ code: 'invalid_token', message: 'Enlace no válido' });
    }
    const user = await this.admin.user.findUnique({
      where: { id: parsed.id },
      select: { id: true, email: true, role: true, emailNoticePrefs: true },
    });
    if (!user) throw new NotFoundException({ code: 'invalid_token', message: 'Enlace no válido' });
    return user;
  }

  async unsubscribeInfo(token: string): Promise<ProductUpdatesDigestUnsubscribeDto> {
    const user = await this.userFromToken(token);
    return {
      email: maskEmail(user.email),
      unsubscribed: !resolveUserEmailNotices(user.emailNoticePrefs, user.role)[NOTICE_KIND],
    };
  }

  async unsubscribe(token: string): Promise<ProductUpdatesDigestUnsubscribeDto> {
    const user = await this.userFromToken(token);
    const current =
      user.emailNoticePrefs && typeof user.emailNoticePrefs === 'object'
        ? (user.emailNoticePrefs as Record<string, unknown>)
        : {};
    await this.admin.user.update({
      where: { id: user.id },
      data: { emailNoticePrefs: { ...current, [NOTICE_KIND]: false } },
    });
    return { email: maskEmail(user.email), unsubscribed: true };
  }
}
