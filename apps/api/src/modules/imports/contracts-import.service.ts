import { Injectable } from '@nestjs/common';
import {
  type ContractBillingCycleValue,
  CreateContractSchema,
  type ImportCommitDto,
  type ImportDuplicatePolicy,
  type ImportPreviewDto,
} from '@storageos/shared';
import Papa from 'papaparse';

import { ContractsService } from '../contracts/contracts.service';
import { PrismaService } from '../database/prisma.service';

import {
  buildPreview,
  flattenZodErrors,
  normalizeDate,
  parseDecimal,
  parseRaw,
  resolveColumns,
  runCommit,
  type RowEval,
  type RowEvaluator,
} from './import-engine';

import type { RequestMeta } from '../auth/auth.service';

type ContractField =
  | 'customerEmail'
  | 'customerDocument'
  | 'unitCode'
  | 'facility'
  | 'startDate'
  | 'endDate'
  | 'priceMonthly'
  | 'billingCycle'
  | 'depositAmount'
  | 'discountAmount'
  | 'notes';

const CONTRACT_ALIASES: Record<string, ContractField> = {
  customeremail: 'customerEmail',
  email: 'customerEmail',
  correo: 'customerEmail',
  customerdocument: 'customerDocument',
  documento: 'customerDocument',
  dni: 'customerDocument',
  nif: 'customerDocument',
  cif: 'customerDocument',
  unitcode: 'unitCode',
  code: 'unitCode',
  codigo: 'unitCode',
  trastero: 'unitCode',
  facility: 'facility',
  local: 'facility',
  startdate: 'startDate',
  fechainicio: 'startDate',
  inicio: 'startDate',
  enddate: 'endDate',
  fechafin: 'endDate',
  fin: 'endDate',
  pricemonthly: 'priceMonthly',
  precio: 'priceMonthly',
  preciomensual: 'priceMonthly',
  billingcycle: 'billingCycle',
  ciclo: 'billingCycle',
  depositamount: 'depositAmount',
  fianza: 'depositAmount',
  deposito: 'depositAmount',
  discountamount: 'discountAmount',
  descuento: 'discountAmount',
  notes: 'notes',
  notas: 'notes',
  observaciones: 'notes',
};

const BILLING_CYCLE_ALIASES: Record<string, ContractBillingCycleValue> = {
  monthly: 'monthly',
  mensual: 'monthly',
  weekly: 'weekly',
  semanal: 'weekly',
  daily: 'daily',
  diario: 'daily',
};

const TEMPLATE_HEADERS = [
  'customerEmail',
  'customerDocument',
  'unitCode',
  'facility',
  'startDate',
  'priceMonthly',
  'billingCycle',
  'depositAmount',
  'notes',
] as const;

interface ContractsCtx {
  customerByEmail: Map<string, string>;
  customerByDoc: Map<string, string>;
  unitsByCode: Map<string, { id: string; facilityId: string }[]>;
  facilityByName: Map<string, string>;
  tenantId: string;
  userId: string;
  meta: RequestMeta;
}

@Injectable()
export class ContractsImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
  ) {}

  template(): string {
    const example: Record<string, string> = {
      customerEmail: 'ana.garcia@example.com',
      customerDocument: '12345678Z',
      unitCode: 'A-101',
      facility: 'Local Centro',
      startDate: '2026-01-01',
      priceMonthly: '75',
      billingCycle: 'monthly',
      depositAmount: '75',
      notes: 'Importado',
    };
    return Papa.unparse({
      fields: [...TEMPLATE_HEADERS],
      data: [TEMPLATE_HEADERS.map((h) => example[h] ?? '')],
    });
  }

  async preview(tenantId: string, csv: string): Promise<ImportPreviewDto> {
    const { columns, records } = parseRaw(csv);
    const ctx = await this.prepare(tenantId, '', {});
    return buildPreview(columns, records, this.makeEvaluator(columns, ctx));
  }

  async commit(args: {
    tenantId: string;
    userId: string;
    meta: RequestMeta;
    csv: string;
    onDuplicate: ImportDuplicatePolicy;
  }): Promise<ImportCommitDto> {
    const { columns, records } = parseRaw(args.csv);
    const ctx = await this.prepare(args.tenantId, args.userId, args.meta);
    return runCommit(records, this.makeEvaluator(columns, ctx), args.onDuplicate);
  }

  private async prepare(
    tenantId: string,
    userId: string,
    meta: RequestMeta,
  ): Promise<ContractsCtx> {
    const [customers, units, facilities] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.customer.findMany({
            where: { deletedAt: null },
            select: { id: true, email: true, documentNumber: true },
          }),
          tx.unit.findMany({ select: { id: true, code: true, facilityId: true } }),
          tx.facility.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
        ]),
      tenantId,
    );

    const customerByEmail = new Map<string, string>();
    const customerByDoc = new Map<string, string>();
    for (const c of customers) {
      if (c.email) customerByEmail.set(c.email.toLowerCase(), c.id);
      if (c.documentNumber) customerByDoc.set(c.documentNumber.toUpperCase(), c.id);
    }
    const unitsByCode = new Map<string, { id: string; facilityId: string }[]>();
    for (const u of units) {
      const key = u.code.toUpperCase();
      const arr = unitsByCode.get(key) ?? [];
      arr.push({ id: u.id, facilityId: u.facilityId });
      unitsByCode.set(key, arr);
    }
    const facilityByName = new Map(facilities.map((f) => [f.name.trim().toLowerCase(), f.id]));

    return { customerByEmail, customerByDoc, unitsByCode, facilityByName, tenantId, userId, meta };
  }

  private makeEvaluator(columns: string[], ctx: ContractsCtx): RowEvaluator {
    const fieldByColumn = resolveColumns(columns, CONTRACT_ALIASES);

    return (raw): RowEval => {
      const get = (field: ContractField): string => {
        for (const [col, f] of fieldByColumn) if (f === field) return (raw[col] ?? '').trim();
        return '';
      };

      const errors: string[] = [];

      // Resolver inquilino por email o documento.
      const email = get('customerEmail').toLowerCase();
      const doc = get('customerDocument').toUpperCase();
      let customerId: string | undefined;
      if (email) customerId = ctx.customerByEmail.get(email);
      if (!customerId && doc) customerId = ctx.customerByDoc.get(doc);
      if (!email && !doc) errors.push('customer: indica email o documento del inquilino');
      else if (!customerId) errors.push('customer: inquilino no encontrado');

      // Resolver trastero por código (+ local opcional para desambiguar).
      const code = get('unitCode').toUpperCase();
      const facilityName = get('facility');
      let unitId: string | undefined;
      if (!code) {
        errors.push('unitCode: falta el código del trastero');
      } else {
        const matches = ctx.unitsByCode.get(code) ?? [];
        if (matches.length === 0) {
          errors.push(`unitCode: trastero no encontrado "${get('unitCode')}"`);
        } else if (matches.length === 1) {
          unitId = matches[0]!.id;
        } else if (facilityName) {
          const facilityId = ctx.facilityByName.get(facilityName.toLowerCase());
          unitId = matches.find((m) => m.facilityId === facilityId)?.id;
          if (!unitId)
            errors.push(`unitCode: código ambiguo y local no coincide "${get('unitCode')}"`);
        } else {
          errors.push(
            `unitCode: código en varios locales, especifica "facility": ${get('unitCode')}`,
          );
        }
      }

      if (errors.length || !customerId || !unitId) {
        return { status: 'error', errors };
      }

      const candidate = {
        customerId,
        unitId,
        startDate: normalizeDate(get('startDate')),
        ...(get('endDate') ? { endDate: normalizeDate(get('endDate')) } : {}),
        priceMonthly: parseDecimal(get('priceMonthly')) ?? undefined,
        ...(get('billingCycle')
          ? {
              billingCycle:
                BILLING_CYCLE_ALIASES[get('billingCycle').toLowerCase()] ?? get('billingCycle'),
            }
          : {}),
        ...(get('depositAmount') ? { depositAmount: parseDecimal(get('depositAmount')) ?? 0 } : {}),
        ...(get('discountAmount')
          ? { discountAmount: parseDecimal(get('discountAmount')) ?? 0 }
          : {}),
        ...(get('notes') ? { notes: get('notes') } : {}),
      };
      const parsed = CreateContractSchema.safeParse(candidate);
      if (!parsed.success) {
        return { status: 'error', errors: flattenZodErrors(parsed.error) };
      }

      // Sin dedup natural: los contratos se importan siempre como borradores.
      return {
        status: 'valid',
        errors: [],
        create: () =>
          this.contracts
            .create({
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              input: parsed.data,
              meta: ctx.meta,
            })
            .then((c) => c.id),
      };
    };
  }
}
