import { Injectable } from '@nestjs/common';
import {
  CreateCustomerSchema,
  type CreateCustomerInput,
  type ImportCommitRowResult,
  type ImportCustomersCommitDto,
  type ImportCustomersPreviewDto,
  type ImportDuplicatePolicy,
  type ImportPreviewRowDto,
} from '@storageos/shared';
import Papa from 'papaparse';

import { AuditService } from '../auth/audit.service';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';

/** Cabeceras canónicas (= nombres de campo) que exporta la plantilla. */
const TEMPLATE_HEADERS = [
  'customerType',
  'firstName',
  'lastName',
  'companyName',
  'documentType',
  'documentNumber',
  'email',
  'phone',
  'address',
  'city',
  'postalCode',
  'country',
  'notes',
  'tags',
] as const;

/** Normaliza una cabecera para casarla con alias (sin acentos, espacios ni mayúsculas). */
function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_]+/g, '');
}

/** Mapa alias normalizado -> campo del schema. */
const HEADER_ALIASES: Record<string, keyof CreateCustomerInput> = {
  customertype: 'customerType',
  tipo: 'customerType',
  tipocliente: 'customerType',
  firstname: 'firstName',
  nombre: 'firstName',
  lastname: 'lastName',
  apellidos: 'lastName',
  apellido: 'lastName',
  companyname: 'companyName',
  empresa: 'companyName',
  razonsocial: 'companyName',
  nombreempresa: 'companyName',
  documenttype: 'documentType',
  tipodocumento: 'documentType',
  documentnumber: 'documentNumber',
  documento: 'documentNumber',
  dni: 'documentNumber',
  nif: 'documentNumber',
  cif: 'documentNumber',
  nifcif: 'documentNumber',
  email: 'email',
  correo: 'email',
  correoelectronico: 'email',
  mail: 'email',
  phone: 'phone',
  telefono: 'phone',
  movil: 'phone',
  tel: 'phone',
  address: 'address',
  direccion: 'address',
  city: 'city',
  ciudad: 'city',
  poblacion: 'city',
  localidad: 'city',
  postalcode: 'postalCode',
  cp: 'postalCode',
  codigopostal: 'postalCode',
  country: 'country',
  pais: 'country',
  notes: 'notes',
  notas: 'notes',
  observaciones: 'notes',
  tags: 'tags',
  etiquetas: 'tags',
};

const CUSTOMER_TYPE_ALIASES: Record<string, 'individual' | 'business'> = {
  individual: 'individual',
  particular: 'individual',
  persona: 'individual',
  business: 'business',
  empresa: 'business',
  company: 'business',
};

interface ParsedRow {
  index: number;
  raw: Record<string, string>;
  /** input mapeado listo para validar (campos no vacíos). */
  mapped: Record<string, unknown>;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
  ) {}

  /** CSV de plantilla con cabeceras canónicas + una fila de ejemplo. */
  customersTemplate(): string {
    const example: Record<string, string> = {
      customerType: 'individual',
      firstName: 'Ana',
      lastName: 'García',
      companyName: '',
      documentType: 'DNI',
      documentNumber: '12345678Z',
      email: 'ana.garcia@example.com',
      phone: '+34 600 123 456',
      address: 'Calle Mayor 1',
      city: 'Madrid',
      postalCode: '28001',
      country: 'ES',
      notes: '',
      tags: 'vip;moroso',
    };
    return Papa.unparse({
      fields: [...TEMPLATE_HEADERS],
      data: [TEMPLATE_HEADERS.map((h) => example[h] ?? '')],
    });
  }

  async previewCustomers(tenantId: string, csv: string): Promise<ImportCustomersPreviewDto> {
    const { columns, rows } = this.parse(csv);
    const existing = await this.loadExistingKeys(tenantId, rows);

    const seenEmails = new Set<string>();
    const seenDocs = new Set<string>();
    const previewRows: ImportPreviewRowDto[] = rows.map((row) => {
      const parsed = CreateCustomerSchema.safeParse(row.mapped);
      if (!parsed.success) {
        return {
          index: row.index,
          raw: row.raw,
          status: 'error',
          errors: flattenZodErrors(parsed.error),
        };
      }
      const dupReason = this.duplicateReason(parsed.data, existing, seenEmails, seenDocs);
      return {
        index: row.index,
        raw: row.raw,
        status: dupReason ? 'duplicate' : 'valid',
        errors: [],
      };
    });

    return {
      columns,
      summary: {
        total: previewRows.length,
        valid: previewRows.filter((r) => r.status === 'valid').length,
        invalid: previewRows.filter((r) => r.status === 'error').length,
        duplicates: previewRows.filter((r) => r.status === 'duplicate').length,
      },
      rows: previewRows,
    };
  }

  async commitCustomers(args: {
    tenantId: string;
    userId: string;
    meta: RequestMeta;
    csv: string;
    onDuplicate: ImportDuplicatePolicy;
  }): Promise<ImportCustomersCommitDto> {
    const { rows } = this.parse(args.csv);
    const existing = await this.loadExistingKeys(args.tenantId, rows);

    const seenEmails = new Set<string>();
    const seenDocs = new Set<string>();
    const results: ImportCommitRowResult[] = [];

    for (const row of rows) {
      const parsed = CreateCustomerSchema.safeParse(row.mapped);
      if (!parsed.success) {
        results.push({ index: row.index, status: 'error', errors: flattenZodErrors(parsed.error) });
        continue;
      }
      const dup = this.duplicateReason(parsed.data, existing, seenEmails, seenDocs);
      if (dup && args.onDuplicate === 'skip') {
        results.push({ index: row.index, status: 'skipped', errors: [dup] });
        continue;
      }
      try {
        const created = await this.customers.create({
          tenantId: args.tenantId,
          userId: args.userId,
          input: parsed.data,
          meta: args.meta,
        });
        results.push({ index: row.index, status: 'created', id: created.id });
      } catch (err) {
        results.push({
          index: row.index,
          status: 'error',
          errors: [err instanceof Error ? err.message : 'Error desconocido'],
        });
      }
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'customer.imported',
      entityType: 'Customer',
      entityId: args.tenantId,
      changes: {
        created: results.filter((r) => r.status === 'created').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        errors: results.filter((r) => r.status === 'error').length,
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });

    return {
      summary: {
        created: results.filter((r) => r.status === 'created').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        errors: results.filter((r) => r.status === 'error').length,
      },
      rows: results,
    };
  }

  // --------------------------------------------------------------------------
  // Internos
  // --------------------------------------------------------------------------

  private parse(csv: string): { columns: string[]; rows: ParsedRow[] } {
    const result = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    });
    const columns = result.meta.fields ?? [];
    const headerToField = new Map<string, keyof CreateCustomerInput>();
    for (const col of columns) {
      const field = HEADER_ALIASES[normalizeHeader(col)];
      if (field) headerToField.set(col, field);
    }

    const rows: ParsedRow[] = (result.data ?? []).map((record, i) => {
      const mapped: Record<string, unknown> = {};
      for (const [col, field] of headerToField) {
        const value = (record[col] ?? '').trim();
        if (!value) continue;
        if (field === 'customerType') {
          mapped.customerType = CUSTOMER_TYPE_ALIASES[value.toLowerCase()] ?? value;
        } else if (field === 'tags') {
          mapped.tags = value
            .split(/[;,]/)
            .map((t) => t.trim())
            .filter(Boolean);
        } else {
          mapped[field] = value;
        }
      }
      return { index: i + 1, raw: record, mapped };
    });

    return { columns, rows };
  }

  /** Carga emails y documentos ya existentes en el tenant para detectar duplicados. */
  private async loadExistingKeys(
    tenantId: string,
    rows: ParsedRow[],
  ): Promise<{ emails: Set<string>; docs: Set<string> }> {
    const emails = new Set<string>();
    const docs = new Set<string>();
    for (const r of rows) {
      const email = typeof r.mapped.email === 'string' ? r.mapped.email.toLowerCase() : '';
      const doc = typeof r.mapped.documentNumber === 'string' ? r.mapped.documentNumber : '';
      if (email) emails.add(email);
      if (doc) docs.add(doc.toUpperCase());
    }
    if (emails.size === 0 && docs.size === 0) {
      return { emails: new Set(), docs: new Set() };
    }
    const found = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: {
            deletedAt: null,
            OR: [
              ...(emails.size ? [{ email: { in: [...emails] } }] : []),
              ...(docs.size ? [{ documentNumber: { in: [...docs] } }] : []),
            ],
          },
          select: { email: true, documentNumber: true },
        }),
      tenantId,
    );
    const existingEmails = new Set<string>();
    const existingDocs = new Set<string>();
    for (const c of found) {
      if (c.email) existingEmails.add(c.email.toLowerCase());
      if (c.documentNumber) existingDocs.add(c.documentNumber.toUpperCase());
    }
    return { emails: existingEmails, docs: existingDocs };
  }

  /** Devuelve el motivo de duplicado o null. Marca también duplicados dentro del propio fichero. */
  private duplicateReason(
    data: CreateCustomerInput,
    existing: { emails: Set<string>; docs: Set<string> },
    seenEmails: Set<string>,
    seenDocs: Set<string>,
  ): string | null {
    const email = data.email ? data.email.toLowerCase() : '';
    const doc = data.documentNumber ? data.documentNumber.toUpperCase() : '';
    let reason: string | null = null;
    if (email && (existing.emails.has(email) || seenEmails.has(email))) {
      reason = `Email duplicado: ${email}`;
    } else if (doc && (existing.docs.has(doc) || seenDocs.has(doc))) {
      reason = `Documento duplicado: ${doc}`;
    }
    if (email) seenEmails.add(email);
    if (doc) seenDocs.add(doc);
    return reason;
  }
}

function flattenZodErrors(error: {
  issues: { path: (string | number)[]; message: string }[];
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
