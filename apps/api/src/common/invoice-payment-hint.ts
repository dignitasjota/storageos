import { CHARGEABLE_MANDATE_WHERE } from './sepa-remittance-guard';

import type { Prisma } from '@storageos/database';

/**
 * Cómo se va a pagar una factura, para decírselo al inquilino (en el correo y
 * en el PDF): cobro automático (tarjeta o adeudo por la pasarela), remesa SEPA
 * del propio negocio, o lo paga él (área de clientes y, si hay, transferencia).
 */
export type InvoicePaymentHint =
  | { via: 'auto_card'; brand: string | null; last4: string | null }
  | { via: 'auto_debit'; last4: string | null }
  | { via: 'sepa_remittance'; last4: string }
  | { via: 'manual'; transferIban: string | null };

type Db = Pick<Prisma.TransactionClient, 'tenant' | 'paymentMethod' | 'sepaMandate'>;

export async function loadInvoicePaymentHint(
  db: Db,
  tenantId: string,
  customerId: string,
): Promise<InvoicePaymentHint> {
  const [tenant, pm, mandate] = await Promise.all([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { autoChargeOnIssue: true, transferIban: true },
    }),
    db.paymentMethod.findFirst({
      where: {
        tenantId,
        customerId,
        isDefault: true,
        deletedAt: null,
        type: { in: ['card', 'sepa_debit'] },
      },
      select: { type: true, brand: true, last4: true },
    }),
    db.sepaMandate.findFirst({
      where: { tenantId, customerId, ...CHARGEABLE_MANDATE_WHERE },
      select: { ibanLast4: true },
    }),
  ]);
  if (tenant?.autoChargeOnIssue && pm) {
    return pm.type === 'card'
      ? { via: 'auto_card', brand: pm.brand, last4: pm.last4 }
      : { via: 'auto_debit', last4: pm.last4 };
  }
  if (mandate) return { via: 'sepa_remittance', last4: mandate.ibanLast4 };
  return { via: 'manual', transferIban: tenant?.transferIban ?? null };
}
