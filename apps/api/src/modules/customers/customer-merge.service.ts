import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { customerScopeWhere } from '../../common/customer-scope';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { FacilityScope } from '../../common/facility-scope';
import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';
import type { CustomerMergePreviewDto } from '@storageos/shared';

/**
 * Tablas que apuntan a un inquilino. Una prueba las compara con las claves
 * ajenas de la base de datos: una tabla nueva sin añadir aquí la hace fallar.
 * `customer_message_reads` y `winback_sends` se mueven aparte por sus únicos.
 */
export const CUSTOMER_REFERENCES: readonly (readonly [string, string])[] = [
  ['access_credentials', 'customer_id'],
  ['access_logs', 'customer_id'],
  ['bank_match_rules', 'customer_id'],
  ['communications', 'customer_id'],
  ['consents', 'customer_id'],
  ['contracts', 'customer_id'],
  ['coupon_redemptions', 'customer_id'],
  ['customer_authorized_persons', 'customer_id'],
  ['customer_contacts', 'customer_id'],
  ['customer_document_requests', 'customer_id'],
  ['customer_documents', 'customer_id'],
  ['customer_followups', 'customer_id'],
  ['customer_interactions', 'customer_id'],
  ['customer_interest_events', 'customer_id'],
  ['customer_messages', 'customer_id'],
  ['customer_offers', 'customer_id'],
  ['data_subject_requests', 'customer_id'],
  ['delinquency_cases', 'customer_id'],
  ['delinquency_pickup_requests', 'customer_id'],
  ['incidents', 'customer_id'],
  ['invoices', 'customer_id'],
  ['leads', 'converted_customer_id'],
  ['legal_doc_acceptances', 'customer_id'],
  ['payment_methods', 'customer_id'],
  ['payment_plans', 'customer_id'],
  ['payments', 'customer_id'],
  ['product_sales', 'customer_id'],
  ['push_subscriptions', 'customer_id'],
  ['referrals', 'referred_customer_id'],
  ['referrals', 'referrer_customer_id'],
  ['reservations', 'customer_id'],
  ['retention_offers', 'customer_id'],
  ['reviews', 'customer_id'],
  ['sepa_mandates', 'customer_id'],
  ['unit_change_requests', 'customer_id'],
  ['unit_requests', 'customer_id'],
  ['waitlist_entries', 'customer_id'],
  ['whatsapp_conversations', 'customer_id'],
];

/** Con restricción de único por inquilino: solo pasa lo que no choca. */
export const CUSTOMER_REFERENCES_WITH_UNIQUE: readonly (readonly [string, string])[] = [
  ['customer_message_reads', 'user_id'],
  ['customer_conversations', 'tenant_id'],
  ['winback_sends', 'step'],
];

const SAME_DATA_FIELDS = [
  'email',
  'phone',
  'documentType',
  'documentNumber',
  'address',
  'city',
  'postalCode',
  'emergencyContactName',
  'emergencyContactPhone',
  'billingEmail',
] as const;

const displayName = (c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}) =>
  (c.customerType === 'business'
    ? c.companyName
    : [c.firstName, c.lastName].filter(Boolean).join(' ')) || 'Sin nombre';

const sameDocument = (a: string | null, b: string | null) =>
  !a || !b || a.replace(/[\s-]/g, '').toUpperCase() === b.replace(/[\s-]/g, '').toUpperCase();

/** Une dos fichas de la misma persona: todo pasa a una y la otra queda borrada. */
@Injectable()
export class CustomerMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async preview(
    tenantId: string,
    targetId: string,
    sourceId: string,
    scope: FacilityScope,
  ): Promise<CustomerMergePreviewDto> {
    return this.prisma.withTenant(async (tx) => {
      const { source, target } = await this.pair(tx, targetId, sourceId, scope);
      const where = { customerId: sourceId };
      const [contracts, invoices, payments, documents, messages, mandates, targetMandate] =
        await Promise.all([
          tx.contract.count({ where: { ...where, deletedAt: null } }),
          tx.invoice.count({ where: { ...where, deletedAt: null } }),
          tx.payment.count({ where }),
          tx.customerDocument.count({ where }),
          tx.customerMessage.count({ where }),
          tx.sepaMandate.count({ where: { ...where, status: 'active' } }),
          tx.sepaMandate.count({ where: { customerId: targetId, status: 'active' } }),
        ]);
      const warnings: string[] = [];
      if (!sameDocument(source.documentNumber, target.documentNumber)) {
        warnings.push('Los documentos son distintos: comprueba que son la misma persona.');
      }
      if (source.customerType !== target.customerType) {
        warnings.push('Uno es particular y el otro empresa.');
      }
      if (mandates > 0 && targetMandate > 0) {
        warnings.push('Los dos tienen mandato SEPA: se cancelará el del que desaparece.');
      }
      const brief = (c: typeof source) => ({
        id: c.id,
        displayName: displayName(c),
        email: c.email,
        documentNumber: c.documentNumber,
      });
      return {
        source: brief(source),
        target: brief(target),
        moves: [
          { label: 'Contratos', count: contracts },
          { label: 'Facturas', count: invoices },
          { label: 'Cobros', count: payments },
          { label: 'Documentos', count: documents },
          { label: 'Mensajes', count: messages },
        ],
        warnings,
      };
    }, tenantId);
  }

  async merge(args: {
    tenantId: string;
    userId: string;
    targetId: string;
    sourceId: string;
    facilityScope: FacilityScope;
    meta: RequestMeta;
  }): Promise<void> {
    const { targetId, sourceId } = args;
    await this.prisma.withTenant(
      async (tx) => {
        const { source, target } = await this.pair(tx, targetId, sourceId, args.facilityScope);

        // Una recomendación entre los dos deja de tener sentido; y solo se puede
        // haber llegado recomendado una vez.
        await tx.referral.deleteMany({
          where: {
            OR: [
              { referrerCustomerId: targetId, referredCustomerId: sourceId },
              { referrerCustomerId: sourceId, referredCustomerId: targetId },
            ],
          },
        });
        if (await tx.referral.count({ where: { referredCustomerId: targetId } })) {
          await tx.referral.deleteMany({ where: { referredCustomerId: sourceId } });
        }
        if (await tx.sepaMandate.count({ where: { customerId: targetId, status: 'active' } })) {
          await tx.sepaMandate.updateMany({
            where: { customerId: sourceId, status: 'active' },
            data: { status: 'cancelled' },
          });
        }
        if (
          await tx.paymentMethod.count({
            where: { customerId: targetId, isDefault: true, deletedAt: null },
          })
        ) {
          await tx.paymentMethod.updateMany({
            where: { customerId: sourceId },
            data: { isDefault: false },
          });
        }
        for (const [table, key] of CUSTOMER_REFERENCES_WITH_UNIQUE) {
          await tx.$executeRawUnsafe(
            `DELETE FROM ${table} s USING ${table} t
             WHERE s.customer_id = $1::uuid AND t.customer_id = $2::uuid AND s.${key} = t.${key}`,
            sourceId,
            targetId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE ${table} SET customer_id = $2::uuid WHERE customer_id = $1::uuid`,
            sourceId,
            targetId,
          );
        }
        for (const [table, column] of CUSTOMER_REFERENCES) {
          await tx.$executeRawUnsafe(
            `UPDATE ${table} SET ${column} = $2::uuid WHERE ${column} = $1::uuid`,
            sourceId,
            targetId,
          );
        }

        // Lo que al que se queda le falta, del otro.
        const fill: Prisma.CustomerUpdateInput = {
          tags: [...new Set([...target.tags, ...source.tags])],
        };
        for (const field of SAME_DATA_FIELDS) {
          if (!target[field] && source[field]) fill[field] = source[field];
        }
        if (source.notes) {
          fill.notes = target.notes ? `${target.notes}\n\n${source.notes}` : source.notes;
        }
        await tx.customer.update({ where: { id: targetId }, data: fill });
        await tx.customer.update({
          where: { id: sourceId },
          data: {
            deletedAt: new Date(),
            mergedIntoCustomerId: targetId,
            portalAccessEnabled: false,
            portalPasswordHash: null,
            portalSessionVersion: { increment: 1 },
            referralCode: null,
          },
        });
      },
      args.tenantId,
      { timeout: 30_000 },
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.merged',
      entityType: 'Customer',
      entityId: targetId,
      changes: { sourceId },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  private async pair(
    tx: Prisma.TransactionClient,
    targetId: string,
    sourceId: string,
    scope: FacilityScope,
  ) {
    if (targetId === sourceId) {
      throw new BadRequestException({
        code: 'same_customer',
        message: 'Elige otro inquilino: no se puede fusionar consigo mismo',
      });
    }
    const rows = await tx.customer.findMany({
      where: { id: { in: [targetId, sourceId] }, deletedAt: null, ...customerScopeWhere(scope) },
    });
    const source = rows.find((r) => r.id === sourceId);
    const target = rows.find((r) => r.id === targetId);
    if (!source || !target) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    if (source.isTest !== target.isTest) {
      throw new ConflictException({
        code: 'merge_test_customer',
        message: 'El inquilino de prueba no se puede fusionar con uno real',
      });
    }
    return { source, target };
  }
}
