import { Injectable } from '@nestjs/common';
import {
  LEAD_STATUS_LABELS,
  normalizeLeadSource,
  type ImportCommitDto,
  type ImportDuplicatePolicy,
  type ImportPreviewDto,
} from '@storageos/shared';
import Papa from 'papaparse';

import { PrismaService } from '../database/prisma.service';

import {
  buildPreview,
  facilitiesByName,
  normalizeDate,
  parseDecimal,
  parseRaw,
  resolveColumns,
  runCommit,
  type RowEval,
  type RowEvaluator,
} from './import-engine';

type LeadField =
  | 'firstName'
  | 'lastName'
  | 'companyName'
  | 'email'
  | 'phone'
  | 'source'
  | 'facility'
  | 'unitType'
  | 'status'
  | 'budget'
  | 'message'
  | 'date';

const ALIASES: Record<string, LeadField> = {
  firstname: 'firstName',
  nombre: 'firstName',
  lastname: 'lastName',
  apellidos: 'lastName',
  apellido: 'lastName',
  company: 'companyName',
  companyname: 'companyName',
  empresa: 'companyName',
  razonsocial: 'companyName',
  email: 'email',
  correo: 'email',
  correoelectronico: 'email',
  phone: 'phone',
  telefono: 'phone',
  movil: 'phone',
  source: 'source',
  origen: 'source',
  canal: 'source',
  facility: 'facility',
  local: 'facility',
  centro: 'facility',
  unittype: 'unitType',
  tamano: 'unitType',
  tipo: 'unitType',
  tipodetrastero: 'unitType',
  status: 'status',
  estado: 'status',
  fase: 'status',
  budget: 'budget',
  presupuesto: 'budget',
  message: 'message',
  mensaje: 'message',
  notas: 'message',
  comentarios: 'message',
  date: 'date',
  fecha: 'date',
  fechaalta: 'date',
  fechadecontacto: 'date',
};

const TEMPLATE_HEADERS = [
  'nombre',
  'apellidos',
  'empresa',
  'email',
  'telefono',
  'origen',
  'local',
  'tamaño',
  'estado',
  'presupuesto',
  'mensaje',
  'fecha',
] as const;

const fold = (v: string): string => v.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const phoneKey = (v: string): string | null => {
  const d = v.replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Fases que se pueden importar (un contacto ganado se importa como inquilino). */
const IMPORTABLE = ['new', 'contacted', 'qualified', 'lost'] as const;
type ImportableStatus = (typeof IMPORTABLE)[number];

interface LeadsCtx {
  tenantId: string;
  facilities: { byName: Map<string, string>; ambiguous: Set<string> };
  unitTypes: Map<string, string>;
  emails: Set<string>;
  phones: Set<string>;
  statuses: Map<string, ImportableStatus>;
}

/**
 * Importación de contactos (leads) desde CSV o Excel: la lista de interesados
 * de otro programa o de una hoja de cálculo. Un contacto con el mismo email o
 * teléfono que otro abierto cuenta como repetido. No dispara el reparto ni los
 * correos automáticos (serían cientos a la vez).
 */
@Injectable()
export class LeadsImportService {
  constructor(private readonly prisma: PrismaService) {}

  template(): string {
    const example: Record<string, string> = {
      nombre: 'Ana',
      apellidos: 'García',
      empresa: '',
      email: 'ana@ejemplo.com',
      telefono: '600111222',
      origen: 'Idealista',
      local: '',
      tamaño: '',
      estado: 'Nuevo',
      presupuesto: '60',
      mensaje: 'Busca un trastero de 5 m² para muebles',
      fecha: '01/10/2026',
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

  private async prepare(tenantId: string): Promise<LeadsCtx> {
    const [facilities, unitTypes, leads] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.facility.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
          tx.unitType.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
          tx.lead.findMany({
            where: { deletedAt: null, status: { in: ['new', 'contacted', 'qualified'] } },
            select: { email: true, phone: true },
          }),
        ]),
      tenantId,
    );
    const statuses = new Map<string, ImportableStatus>();
    for (const s of IMPORTABLE) {
      statuses.set(s, s);
      statuses.set(fold(LEAD_STATUS_LABELS[s]), s);
    }
    statuses.set('nueva', 'new');
    statuses.set('contactada', 'contacted');
    statuses.set('cualificada', 'qualified');
    statuses.set('perdida', 'lost');
    return {
      tenantId,
      facilities: facilitiesByName(facilities),
      unitTypes: new Map(unitTypes.map((u) => [fold(u.name), u.id])),
      emails: new Set(leads.flatMap((l) => (l.email ? [l.email.toLowerCase()] : []))),
      phones: new Set(leads.flatMap((l) => (l.phone ? [phoneKey(l.phone) ?? ''] : []))),
      statuses,
    };
  }

  private makeEvaluator(columns: string[], ctx: LeadsCtx): RowEvaluator {
    const fieldByColumn = resolveColumns(columns, ALIASES);
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    return (raw): RowEval => {
      const get = (field: LeadField): string => {
        for (const [col, f] of fieldByColumn) if (f === field) return (raw[col] ?? '').trim();
        return '';
      };
      const errors: string[] = [];
      const firstName = get('firstName').slice(0, 100);
      const lastName = get('lastName').slice(0, 150);
      const companyName = get('companyName').slice(0, 200);
      const email = get('email').toLowerCase();
      const phone = get('phone').slice(0, 30);
      if (!firstName && !lastName && !companyName && !email && !phone) {
        errors.push('Falta el nombre, el email o el teléfono');
      }
      if (email && !EMAIL_RE.test(email)) errors.push(`email: «${email}» no es válido`);
      const pk = phone ? phoneKey(phone) : null;
      if (phone && !pk) errors.push(`teléfono: «${phone}» no es válido`);

      const facilityText = get('facility');
      let facilityId: string | null = null;
      if (facilityText) {
        const key = facilityText.toLowerCase();
        if (ctx.facilities.ambiguous.has(key)) errors.push(`local: hay varios «${facilityText}»`);
        else {
          facilityId = ctx.facilities.byName.get(key) ?? null;
          if (!facilityId) errors.push(`local: «${facilityText}» no existe`);
        }
      }
      const unitTypeText = get('unitType');
      const unitTypeId = unitTypeText ? (ctx.unitTypes.get(fold(unitTypeText)) ?? null) : null;
      if (unitTypeText && !unitTypeId) errors.push(`tamaño: «${unitTypeText}» no existe`);

      const statusText = get('status');
      const status: ImportableStatus = statusText
        ? (ctx.statuses.get(fold(statusText)) ?? 'new')
        : 'new';
      if (statusText && !ctx.statuses.has(fold(statusText))) {
        errors.push(
          `estado: «${statusText}» no se reconoce (nuevo, contactado, cualificado o perdido)`,
        );
      }
      const budgetText = get('budget');
      const budget = budgetText ? parseDecimal(budgetText) : null;
      if (budgetText && (budget === null || budget < 0 || budget > 100_000)) {
        errors.push('presupuesto: escribe un importe');
      }
      const dateText = get('date');
      let createdAt: Date | null = null;
      if (dateText) {
        const iso = normalizeDate(dateText);
        const d = new Date(`${iso}T09:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(d.getTime()) || d > new Date()) {
          errors.push(`fecha: «${dateText}» no es válida`);
        } else createdAt = d;
      }
      if (errors.length) return { status: 'error', errors };

      const duplicate =
        (!!email && (ctx.emails.has(email) || seenEmails.has(email))) ||
        (!!pk && (ctx.phones.has(pk) || seenPhones.has(pk)));
      if (email) seenEmails.add(email);
      if (pk) seenPhones.add(pk);
      const source = normalizeLeadSource(get('source') || 'import') || 'import';
      const message = get('message').slice(0, 2000);
      const at = createdAt ?? new Date();
      return {
        status: duplicate ? 'duplicate' : 'valid',
        errors: duplicate ? ['Ya hay un contacto abierto con ese email o teléfono'] : [],
        create: async () => {
          const created = await this.prisma.withTenant(
            (tx) =>
              tx.lead.create({
                data: {
                  tenantId: ctx.tenantId,
                  source,
                  status,
                  firstName: firstName || null,
                  lastName: lastName || null,
                  companyName: companyName || null,
                  email: email || null,
                  phone: phone || null,
                  message: message || null,
                  preferredFacilityId: facilityId,
                  preferredUnitTypeId: unitTypeId,
                  budgetMonthly: budget,
                  // Importado: no recibe la secuencia de correos automáticos.
                  nurtureStep: 3,
                  createdAt: at,
                  ...(status !== 'new' ? { contactedAt: at } : {}),
                  ...(status === 'qualified' ? { qualifiedAt: at } : {}),
                  ...(status === 'lost' ? { lostAt: at, lostReasonCode: 'other' } : {}),
                  metadata: { origin: 'import' },
                },
                select: { id: true },
              }),
            ctx.tenantId,
          );
          return created.id;
        },
      };
    };
  }
}
