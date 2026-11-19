import { PAYABLE_INVOICE_WHERE } from './sepa-remittance-guard';

import type { Prisma } from '@storageos/database';

/** Lo que hay que pagar del primer pago de un contrato firmado por enlace. */
export interface FirstPaymentDue {
  /** La factura del alquiler (sin emitir hasta que se cobre). */
  invoiceId: string;
  contractId: string | null;
  /** Líneas de esa factura, con IVA. */
  lines: { description: string; amount: number }[];
  /** Lo pendiente de la factura y de la fianza que va con ella. */
  rent: number;
  deposit: number;
  total: number;
  /** Plazo para pagarlo; después la reserva se cancela. */
  deadline: Date | null;
}

type Db = Pick<Prisma.TransactionClient, 'invoice'>;

/**
 * El primer pago al que pertenece la factura indicada (o el de un contrato):
 * la factura del alquiler y los justificantes de fianza que se cobran con ella.
 * Null si no queda nada que pagar.
 */
export async function loadFirstPayment(
  db: Db,
  tenantId: string,
  where: Prisma.InvoiceWhereInput,
): Promise<FirstPaymentDue | null> {
  const invoice = await db.invoice.findFirst({
    where: { ...where, tenantId, kind: 'invoice', deletedAt: null, ...PAYABLE_INVOICE_WHERE },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      contractId: true,
      total: true,
      amountPaid: true,
      items: { select: { description: true, total: true }, orderBy: { position: 'asc' } },
      contract: { select: { firstPaymentDeadline: true } },
    },
  });
  if (!invoice) return null;
  const receipts = await db.invoice.findMany({
    where: {
      tenantId,
      bundledWithInvoiceId: invoice.id,
      kind: 'deposit_receipt',
      deletedAt: null,
      ...PAYABLE_INVOICE_WHERE,
    },
    select: { total: true, amountPaid: true },
  });
  const cents = (n: unknown) => Math.round(Number(n) * 100);
  const rent = Math.max(0, cents(invoice.total) - cents(invoice.amountPaid));
  const deposit = receipts.reduce(
    (sum, r) => sum + Math.max(0, cents(r.total) - cents(r.amountPaid)),
    0,
  );
  if (rent + deposit <= 0) return null;
  return {
    invoiceId: invoice.id,
    contractId: invoice.contractId,
    lines: invoice.items.map((i) => ({ description: i.description, amount: Number(i.total) })),
    rent: rent / 100,
    deposit: deposit / 100,
    total: (rent + deposit) / 100,
    deadline: invoice.contract?.firstPaymentDeadline ?? null,
  };
}

/**
 * El primer pago sin emitir al que pertenece una factura: la propia factura o,
 * si es un justificante de fianza, la factura con la que se cobra. Solo cuando
 * la factura sigue sin número (se emite al cobrarse).
 */
export async function loadPendingFirstPayment(
  db: Db,
  tenantId: string,
  invoiceId: string,
): Promise<FirstPaymentDue | null> {
  const row = await db.invoice.findFirst({
    where: { id: invoiceId, tenantId, deletedAt: null },
    select: { status: true, issueOnPayment: true, kind: true, bundledWithInvoiceId: true },
  });
  if (!row || row.status !== 'draft' || !row.issueOnPayment) return null;
  const mainId = row.kind === 'deposit_receipt' ? row.bundledWithInvoiceId : invoiceId;
  if (!mainId) return null;
  return loadFirstPayment(db, tenantId, { id: mainId, status: 'draft', issueOnPayment: true });
}

/**
 * La factura con la que se paga un documento: si es un justificante de fianza
 * que va con una factura aún por pagar, esa factura (que cobra las dos de una
 * vez); si no, el propio documento. Así, pagar la fianza suelta mientras su
 * factura está pendiente cobra las dos juntas y no deja la otra para después.
 */
export async function paymentHeadId(db: Db, tenantId: string, invoiceId: string): Promise<string> {
  const row = await db.invoice.findFirst({
    where: { id: invoiceId, tenantId, deletedAt: null },
    select: { kind: true, bundledWithInvoiceId: true },
  });
  if (row?.kind !== 'deposit_receipt' || !row.bundledWithInvoiceId) return invoiceId;
  const head = await db.invoice.findFirst({
    where: {
      id: row.bundledWithInvoiceId,
      tenantId,
      kind: 'invoice',
      deletedAt: null,
      ...PAYABLE_INVOICE_WHERE,
    },
    select: { id: true, total: true, amountPaid: true },
  });
  if (!head) return invoiceId;
  const pending = Math.round(Number(head.total) * 100) - Math.round(Number(head.amountPaid) * 100);
  return pending > 0 ? head.id : invoiceId;
}
