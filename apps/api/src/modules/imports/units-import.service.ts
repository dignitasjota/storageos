import { Injectable } from '@nestjs/common';
import {
  CreateUnitSchema,
  type ImportCommitDto,
  type ImportDuplicatePolicy,
  type ImportPreviewDto,
} from '@storageos/shared';
import Papa from 'papaparse';

import { PrismaService } from '../database/prisma.service';
import { UnitsService } from '../facilities/units.service';

import {
  buildPreview,
  flattenZodErrors,
  parseDecimal,
  parseRaw,
  resolveColumns,
  runCommit,
  type RowEval,
  type RowEvaluator,
} from './import-engine';

import type { RequestMeta } from '../auth/auth.service';

type UnitField =
  | 'facility'
  | 'unitType'
  | 'code'
  | 'widthM'
  | 'depthM'
  | 'heightM'
  | 'basePriceMonthly'
  | 'notes';

const UNIT_ALIASES: Record<string, UnitField> = {
  facility: 'facility',
  local: 'facility',
  nombrelocal: 'facility',
  sede: 'facility',
  unittype: 'unitType',
  tipo: 'unitType',
  tipotrastero: 'unitType',
  tipounidad: 'unitType',
  code: 'code',
  codigo: 'code',
  referencia: 'code',
  ref: 'code',
  widthm: 'widthM',
  ancho: 'widthM',
  depthm: 'depthM',
  fondo: 'depthM',
  profundidad: 'depthM',
  largo: 'depthM',
  heightm: 'heightM',
  alto: 'heightM',
  altura: 'heightM',
  basepricemonthly: 'basePriceMonthly',
  precio: 'basePriceMonthly',
  preciomensual: 'basePriceMonthly',
  preciobase: 'basePriceMonthly',
  notes: 'notes',
  notas: 'notes',
  observaciones: 'notes',
};

const TEMPLATE_HEADERS = [
  'facility',
  'unitType',
  'code',
  'widthM',
  'depthM',
  'heightM',
  'basePriceMonthly',
  'notes',
] as const;

interface UnitsCtx {
  facilityByName: Map<string, string>;
  unitTypeByName: Map<string, string>;
  existingKeys: Set<string>;
  seen: Set<string>;
  tenantId: string;
  userId: string;
  meta: RequestMeta;
}

@Injectable()
export class UnitsImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: UnitsService,
  ) {}

  template(): string {
    const example: Record<string, string> = {
      facility: 'Local Centro',
      unitType: 'Mediano',
      code: 'A-101',
      widthM: '2',
      depthM: '2,5',
      heightM: '2,4',
      basePriceMonthly: '75',
      notes: '',
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

  private async prepare(tenantId: string, userId: string, meta: RequestMeta): Promise<UnitsCtx> {
    const [facilities, unitTypes, units] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.facility.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }),
          tx.unitType.findMany({ select: { id: true, name: true } }),
          tx.unit.findMany({ select: { facilityId: true, code: true } }),
        ]),
      tenantId,
    );
    const facilityByName = new Map(facilities.map((f) => [f.name.trim().toLowerCase(), f.id]));
    const unitTypeByName = new Map(unitTypes.map((t) => [t.name.trim().toLowerCase(), t.id]));
    const existingKeys = new Set(units.map((u) => `${u.facilityId}::${u.code.toUpperCase()}`));
    return {
      facilityByName,
      unitTypeByName,
      existingKeys,
      seen: new Set(),
      tenantId,
      userId,
      meta,
    };
  }

  private makeEvaluator(columns: string[], ctx: UnitsCtx): RowEvaluator {
    const fieldByColumn = resolveColumns(columns, UNIT_ALIASES);

    return (raw): RowEval => {
      const get = (field: UnitField): string => {
        for (const [col, f] of fieldByColumn) if (f === field) return (raw[col] ?? '').trim();
        return '';
      };

      const facilityName = get('facility');
      const unitTypeName = get('unitType');
      const errors: string[] = [];

      const facilityId = facilityName
        ? ctx.facilityByName.get(facilityName.toLowerCase())
        : undefined;
      if (!facilityName) errors.push('facility: falta el local');
      else if (!facilityId) errors.push(`facility: local no encontrado "${facilityName}"`);

      const unitTypeId = unitTypeName
        ? ctx.unitTypeByName.get(unitTypeName.toLowerCase())
        : undefined;
      if (!unitTypeName) errors.push('unitType: falta el tipo de trastero');
      else if (!unitTypeId) errors.push(`unitType: tipo no encontrado "${unitTypeName}"`);

      if (errors.length) return { status: 'error', errors };

      const candidate = {
        facilityId,
        unitTypeId,
        code: get('code'),
        widthM: parseDecimal(get('widthM')) ?? undefined,
        depthM: parseDecimal(get('depthM')) ?? undefined,
        heightM: parseDecimal(get('heightM')) ?? undefined,
        basePriceMonthly: parseDecimal(get('basePriceMonthly')) ?? undefined,
        notes: get('notes') || undefined,
      };
      const parsed = CreateUnitSchema.safeParse(candidate);
      if (!parsed.success) {
        return { status: 'error', errors: flattenZodErrors(parsed.error) };
      }

      const key = `${facilityId}::${parsed.data.code.toUpperCase()}`;
      const duplicate = ctx.existingKeys.has(key) || ctx.seen.has(key);
      ctx.seen.add(key);

      return {
        status: duplicate ? 'duplicate' : 'valid',
        errors: duplicate ? [`Código duplicado en el local: ${parsed.data.code}`] : [],
        create: () =>
          this.units
            .create({
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              input: parsed.data,
              meta: ctx.meta,
            })
            .then((u) => u.id),
      };
    };
  }
}
