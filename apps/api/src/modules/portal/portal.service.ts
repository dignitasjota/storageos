import { randomBytes } from 'node:crypto';

import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { PortalMagicLinkEmail } from '../email/templates/portal-magic-link';

import type { Env } from '../../config/env.schema';
import type {
  PortalInvoiceDto,
  PortalRequestMagicLinkInput,
  PortalSessionDto,
} from '@storageos/shared';

const PORTAL_TOKEN_PREFIX_REGEX = /^[0-9a-f]{16,64}\.[A-Za-z0-9_-]{20,}$/;

/**
 * Portal del inquilino: acceso de lectura via magic link al email.
 *
 * Flujo:
 *   1. Cliente final visita `/portal/login`, mete `(tenantSlug, email)`.
 *   2. Backend genera un token `<recordId>.<secret>` (formato identico
 *      al de invitaciones), hashed argon2id en la BD (reuso conceptual
 *      de `consents` table no aplica; usamos `data_subject_requests`
 *      NO porque cambiarian su semantica. En Fase 4 generamos un token
 *      efimero in-memory que se manda al email del customer; el cliente
 *      lo intercambia por un JWT de portal corto).
 *
 * Para MVP no persistimos el magic link en BD (cambio minimo de schema).
 * Si lo necesitamos en Fase 8 (auditoria, multi-uso), creamos una tabla
 * `portal_login_tokens`.
 *
 * El JWT del portal NO comparte secret con el access JWT del staff:
 * usa `JWT_2FA_PENDING_SECRET` con `purpose: 'portal'` (TTL 30 min).
 */
@Injectable()
export class PortalService {
  /** Cache in-memory: tokenId → { secretHash, customerId, tenantId, expiresAt }. */
  private readonly magicLinkCache = new Map<
    string,
    { secretHash: string; customerId: string; tenantId: string; expiresAt: number }
  >();

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async requestMagicLink(input: PortalRequestMagicLinkInput): Promise<void> {
    const tenant = await this.admin.tenant.findUnique({
      where: { slug: input.tenantSlug },
    });
    if (!tenant || tenant.deletedAt) return; // 204 silencioso para no filtrar.
    const customer = await this.admin.customer.findFirst({
      where: { tenantId: tenant.id, email: input.email, deletedAt: null },
    });
    if (!customer) return;

    const tokenId = randomBytes(16).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await argonHash(secret);
    this.magicLinkCache.set(tokenId, {
      secretHash,
      customerId: customer.id,
      tenantId: tenant.id,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    this.cleanupExpired();

    const webBase = this.config.get('WEB_BASE_URL', { infer: true });
    const link = `${webBase}/portal/consume?token=${tokenId}.${secret}`;
    await this.email.send({
      to: input.email,
      subject: `Accede a tu cuenta de ${tenant.name}`,
      template: PortalMagicLinkEmail({
        tenantName: tenant.name,
        link,
        ttlMinutes: 30,
      }),
    });
  }

  async consumeMagicLink(token: string): Promise<PortalSessionDto> {
    if (!PORTAL_TOKEN_PREFIX_REGEX.test(token)) {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace invalido',
      });
    }
    const [tokenId, secret] = token.split('.');
    if (!tokenId || !secret) {
      throw new UnauthorizedException({ code: 'portal_token_invalid', message: 'Enlace invalido' });
    }
    this.cleanupExpired();
    const entry = this.magicLinkCache.get(tokenId);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new UnauthorizedException({
        code: 'portal_token_expired',
        message: 'Enlace caducado',
      });
    }
    const ok = await argonVerify(entry.secretHash, secret);
    if (!ok) {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Enlace invalido',
      });
    }
    // Single-use.
    this.magicLinkCache.delete(tokenId);

    const customer = await this.admin.customer.findUniqueOrThrow({
      where: { id: entry.customerId },
    });
    const tenant = await this.admin.tenant.findUniqueOrThrow({
      where: { id: entry.tenantId },
    });
    const ttl = 30 * 60;
    const accessToken = await this.jwt.signAsync(
      { customerId: customer.id, tenantId: tenant.id, purpose: 'portal' },
      {
        subject: customer.id,
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
        expiresIn: ttl,
      },
    );
    const displayName =
      customer.customerType === 'business'
        ? (customer.companyName ?? 'Empresa')
        : [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
    return {
      customerId: customer.id,
      customerName: displayName,
      email: customer.email ?? '',
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      accessToken,
      expiresIn: ttl,
    };
  }

  async verifyPortalToken(token: string): Promise<{ customerId: string; tenantId: string }> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        customerId: string;
        tenantId: string;
        purpose: string;
      }>(token, {
        secret: this.config.get('JWT_2FA_PENDING_SECRET', { infer: true }),
      });
      if (payload.purpose !== 'portal') {
        throw new Error('purpose');
      }
      return { customerId: payload.customerId, tenantId: payload.tenantId };
    } catch {
      throw new UnauthorizedException({
        code: 'portal_token_invalid',
        message: 'Sesion invalida',
      });
    }
  }

  async listMyInvoices(tenantId: string, customerId: string): Promise<PortalInvoiceDto[]> {
    const customer = await this.admin.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'customer_not_found', message: 'No encontrado' });
    }
    const rows = await this.admin.invoice.findMany({
      where: {
        tenantId,
        customerId,
        deletedAt: null,
        status: { in: ['issued', 'overdue', 'paid', 'refunded', 'partially_refunded'] },
      },
      orderBy: { issueDate: 'desc' },
    });
    return rows.map((r) => {
      const total = Number(r.total);
      const paid = Number(r.amountPaid);
      return {
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        issueDate: r.issueDate ? r.issueDate.toISOString().slice(0, 10) : null,
        dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
        total,
        amountPaid: paid,
        amountPending: Math.max(0, total - paid),
        status: r.status,
        pdfUrl: r.pdfUrl,
      };
    });
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.magicLinkCache.entries()) {
      if (v.expiresAt < now) this.magicLinkCache.delete(k);
    }
  }
}
