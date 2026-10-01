import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  maskEmail,
  parseUnsubscribeToken,
  unsubscribeKey,
} from '../../common/marketing/unsubscribe-token';
import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Env } from '../../config/env.schema';
import type { UnsubscribeInfoDto } from '@storageos/shared';

/**
 * Baja de las comunicaciones comerciales desde el enlace del correo (sin
 * sesión). El token identifica al cliente o lead y va firmado.
 */
@Injectable()
export class UnsubscribeService {
  private readonly logger = new Logger(UnsubscribeService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async info(token: string): Promise<UnsubscribeInfoDto> {
    const target = await this.resolve(token);
    return {
      tenantName: target.tenantName,
      email: maskEmail(target.email),
      unsubscribed: target.unsubscribed,
    };
  }

  /** Da de baja (idempotente). */
  async unsubscribe(token: string): Promise<UnsubscribeInfoDto> {
    const target = await this.resolve(token);
    if (!target.unsubscribed) {
      const now = new Date();
      if (target.kind === 'c') {
        await this.admin.customer.update({
          where: { id: target.id },
          data: { marketingOptOutAt: now },
        });
      } else {
        await this.admin.lead.update({
          where: { id: target.id },
          data: { marketingOptOutAt: now },
        });
      }
      await this.admin.auditLog
        .create({
          data: {
            tenantId: target.tenantId,
            userId: null,
            action:
              target.kind === 'c' ? 'customer.marketing_opted_out' : 'lead.marketing_opted_out',
            entityType: target.kind === 'c' ? 'Customer' : 'Lead',
            entityId: target.id,
            changes: { channel: 'unsubscribe_link' },
          },
        })
        .catch(() => undefined);
      this.logger.log(`[unsubscribe] ${target.kind}:${target.id} tenant=${target.tenantId}`);
    }
    return { tenantName: target.tenantName, email: maskEmail(target.email), unsubscribed: true };
  }

  private async resolve(token: string): Promise<{
    kind: 'c' | 'l';
    id: string;
    tenantId: string;
    tenantName: string;
    email: string;
    unsubscribed: boolean;
  }> {
    const parsed = parseUnsubscribeToken(
      unsubscribeKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true })),
      token,
    );
    const notFound = new NotFoundException({
      code: 'unsubscribe_link_invalid',
      message: 'El enlace de baja no es válido',
    });
    if (!parsed) throw notFound;
    if (parsed.kind === 'c') {
      const c = await this.admin.customer.findFirst({
        where: { id: parsed.id },
        select: {
          tenantId: true,
          email: true,
          marketingOptOutAt: true,
          tenant: { select: { name: true } },
        },
      });
      if (!c?.email) throw notFound;
      return {
        kind: 'c',
        id: parsed.id,
        tenantId: c.tenantId,
        tenantName: c.tenant.name,
        email: c.email,
        unsubscribed: !!c.marketingOptOutAt,
      };
    }
    const l = await this.admin.lead.findFirst({
      where: { id: parsed.id },
      select: {
        tenantId: true,
        email: true,
        marketingOptOutAt: true,
        tenant: { select: { name: true } },
      },
    });
    if (!l?.email) throw notFound;
    return {
      kind: 'l',
      id: parsed.id,
      tenantId: l.tenantId,
      tenantName: l.tenant.name,
      email: l.email,
      unsubscribed: !!l.marketingOptOutAt,
    };
  }
}
