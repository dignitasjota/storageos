import { Injectable } from '@nestjs/common';
import {
  CreateSepaMandateSchema,
  type ImportCommitDto,
  type ImportDuplicatePolicy,
  type ImportPreviewDto,
} from '@storageos/shared';
import Papa from 'papaparse';

import { PrismaService } from '../database/prisma.service';
import { SepaService } from '../sepa/sepa.service';

import {
  buildPreview,
  flattenZodErrors,
  normalizeDate,
  parseRaw,
  resolveColumns,
  runCommit,
  type RowEval,
  type RowEvaluator,
} from './import-engine';

type MandateField =
  | 'customerEmail'
  | 'customerDocument'
  | 'iban'
  | 'bic'
  | 'signedAt'
  | 'reference'
  | 'alreadyCollected';

const MANDATE_ALIASES: Record<string, MandateField> = {
  customeremail: 'customerEmail',
  email: 'customerEmail',
  correo: 'customerEmail',
  customerdocument: 'customerDocument',
  documento: 'customerDocument',
  dni: 'customerDocument',
  nif: 'customerDocument',
  cif: 'customerDocument',
  iban: 'iban',
  cuenta: 'iban',
  bic: 'bic',
  swift: 'bic',
  signedat: 'signedAt',
  fechafirma: 'signedAt',
  firma: 'signedAt',
  fecha: 'signedAt',
  reference: 'reference',
  referencia: 'reference',
  referenciamandato: 'reference',
  mandato: 'reference',
  umr: 'reference',
  alreadycollected: 'alreadyCollected',
  yacobrado: 'alreadyCollected',
  cobrado: 'alreadyCollected',
  recurrente: 'alreadyCollected',
};

const TEMPLATE_HEADERS = [
  'customerEmail',
  'customerDocument',
  'iban',
  'bic',
  'signedAt',
  'reference',
  'alreadyCollected',
] as const;

/** Caracteres que admite una referencia de mandato SEPA (máx. 35). */
const REFERENCE_RE = /^[A-Za-z0-9+?/:().,' -]{1,35}$/;
const YES = new Set(['si', 'sí', 's', 'yes', 'y', 'true', '1', 'x', 'rcur']);

interface MandatesCtx {
  tenantId: string;
  customerByEmail: Map<string, string>;
  customerByDoc: Map<string, string>;
  /** Clientes con un mandato activo (importar otro lo sustituye). */
  withActiveMandate: Set<string>;
  existingReferences: Set<string>;
}

/**
 * Importación de mandatos SEPA de otro sistema. Conserva la referencia de cada
 * mandato (cambiarla equivale a un mandato nuevo) y, si ya hubo cobros, lo deja
 * como recurrente (RCUR) para que la primera remesa no vaya como primer adeudo.
 * Un cliente con mandato activo cuenta como duplicado: por defecto se omite; con
 * «crear igualmente», el importado sustituye al actual.
 */
@Injectable()
export class SepaMandatesImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sepa: SepaService,
  ) {}

  template(): string {
    const example: Record<string, string> = {
      customerEmail: 'ana.garcia@example.com',
      customerDocument: '12345678Z',
      iban: 'ES91 2100 0418 4502 0005 1332',
      bic: 'CAIXESBBXXX',
      signedAt: '2024-03-15',
      reference: 'MND-000123',
      alreadyCollected: 'sí',
    };
    return Papa.unparse({
      fields: [...TEMPLATE_HEADERS],
      data: [TEMPLATE_HEADERS.map((h) => example[h] ?? '')],
    });
  }

  async preview(tenantId: string, csv: string): Promise<ImportPreviewDto> {
    const { columns, records } = parseRaw(csv);
    const ctx = await this.prepare(tenantId);
    return buildPreview(columns, records, this.makeEvaluator(columns, ctx));
  }

  async commit(args: {
    tenantId: string;
    csv: string;
    onDuplicate: ImportDuplicatePolicy;
  }): Promise<ImportCommitDto> {
    const { columns, records } = parseRaw(args.csv);
    const ctx = await this.prepare(args.tenantId);
    return runCommit(records, this.makeEvaluator(columns, ctx), args.onDuplicate);
  }

  private async prepare(tenantId: string): Promise<MandatesCtx> {
    const [customers, mandates] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.customer.findMany({
            where: { deletedAt: null },
            select: { id: true, email: true, documentNumber: true },
          }),
          tx.sepaMandate.findMany({ select: { customerId: true, reference: true, status: true } }),
        ]),
      tenantId,
    );
    const customerByEmail = new Map<string, string>();
    const customerByDoc = new Map<string, string>();
    for (const c of customers) {
      if (c.email) customerByEmail.set(c.email.toLowerCase(), c.id);
      if (c.documentNumber) customerByDoc.set(c.documentNumber.toUpperCase(), c.id);
    }
    return {
      tenantId,
      customerByEmail,
      customerByDoc,
      withActiveMandate: new Set(
        mandates.filter((m) => m.status === 'active').map((m) => m.customerId),
      ),
      existingReferences: new Set(mandates.map((m) => m.reference.toUpperCase())),
    };
  }

  private makeEvaluator(columns: string[], ctx: MandatesCtx): RowEvaluator {
    const fieldByColumn = resolveColumns(columns, MANDATE_ALIASES);
    // Referencias ya vistas en el propio fichero (dos filas con la misma).
    const seenReferences = new Set<string>();

    return (raw): RowEval => {
      const get = (field: MandateField): string => {
        for (const [col, f] of fieldByColumn) if (f === field) return (raw[col] ?? '').trim();
        return '';
      };
      const errors: string[] = [];

      const email = get('customerEmail').toLowerCase();
      const doc = get('customerDocument').toUpperCase();
      let customerId: string | undefined;
      if (email) customerId = ctx.customerByEmail.get(email);
      if (!customerId && doc) customerId = ctx.customerByDoc.get(doc);
      if (!email && !doc) errors.push('customer: indica email o documento del inquilino');
      else if (!customerId) errors.push('customer: inquilino no encontrado');

      const reference = get('reference');
      if (reference) {
        if (!REFERENCE_RE.test(reference)) {
          errors.push("reference: hasta 35 caracteres (letras, números y + ? / - : ( ) . , ')");
        } else if (ctx.existingReferences.has(reference.toUpperCase())) {
          errors.push(`reference: ya existe un mandato con la referencia ${reference}`);
        } else if (seenReferences.has(reference.toUpperCase())) {
          errors.push(`reference: repetida en el fichero (${reference})`);
        }
      }

      const parsed = CreateSepaMandateSchema.safeParse({
        customerId: customerId ?? '00000000-0000-0000-0000-000000000000',
        iban: get('iban'),
        ...(get('bic') ? { bic: get('bic') } : {}),
        signedAt: normalizeDate(get('signedAt')),
      });
      if (!parsed.success) errors.push(...flattenZodErrors(parsed.error));

      if (errors.length || !customerId || !parsed.success) {
        return { status: 'error', errors };
      }
      if (reference) seenReferences.add(reference.toUpperCase());

      const input = { ...parsed.data, customerId };
      const sequenceType = YES.has(get('alreadyCollected').toLowerCase()) ? 'RCUR' : 'FRST';
      const duplicate = ctx.withActiveMandate.has(customerId);
      return {
        status: duplicate ? 'duplicate' : 'valid',
        errors: duplicate ? ['El inquilino ya tiene un mandato activo (se sustituiría)'] : [],
        create: () =>
          this.sepa
            .createMandate(ctx.tenantId, input, {
              ...(reference ? { reference } : {}),
              sequenceType,
            })
            .then((m) => m.id),
      };
    };
  }
}
