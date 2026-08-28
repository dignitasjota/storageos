import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { Env } from '../../config/env.schema';

const csvCell = (v: string): string => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

interface CatalogFeedRow {
  facilityName: string;
  address: string;
  city: string;
  postalCode: string;
  unitTypeName: string;
  description: string;
  areaM2: number | null;
  volumeM3: number | null;
  priceMonthly: number;
  available: number;
  phone: string;
  email: string;
  bookingUrl: string;
  photos: string[];
}

/**
 * Feed genérico (CSV) del catálogo de trasteros disponibles, para copiar/pegar
 * o subir a portales inmobiliarios (Idealista, Fotocasa, Wallapop…) que no
 * tienen API pública de publicación para terceros — ni Idealista ni Fotocasa
 * la ofrecen fuera de un contrato de agencia con feed propietario, así que
 * esto NO es un feed específico de un portal (no tenemos su esquema real),
 * es un export universal con los campos que cualquier formulario de
 * publicación pide. Una fila por combinación (local × tipo de trastero) con
 * disponibilidad > 0.
 */
@Injectable()
export class CatalogFeedService {
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true });
  }

  async exportCsv(tenantId: string, facilityId?: string): Promise<string> {
    const rows = await this.buildRows(tenantId, facilityId);
    const header = [
      'Local',
      'Dirección',
      'Ciudad',
      'Código postal',
      'Tipo de trastero',
      'Descripción',
      'Superficie (m²)',
      'Volumen (m³)',
      'Precio/mes (IVA incl.)',
      'Disponibles',
      'Teléfono',
      'Email',
      'Enlace de reserva',
      'Fotos',
    ];
    const lines = [header.map(csvCell).join(';')];
    for (const r of rows) {
      lines.push(
        [
          csvCell(r.facilityName),
          csvCell(r.address),
          csvCell(r.city),
          csvCell(r.postalCode),
          csvCell(r.unitTypeName),
          csvCell(r.description),
          r.areaM2 != null ? r.areaM2.toFixed(1) : '',
          r.volumeM3 != null ? r.volumeM3.toFixed(1) : '',
          r.priceMonthly.toFixed(2),
          String(r.available),
          csvCell(r.phone),
          csvCell(r.email),
          csvCell(r.bookingUrl),
          csvCell(r.photos.join(' | ')),
        ].join(';'),
      );
    }
    // BOM (U+FEFF) para que Excel detecte UTF-8; se escribe con charCode (no
    // literal) por el lint `no-irregular-whitespace`.
    return String.fromCharCode(0xfeff) + lines.join('\r\n');
  }

  private async buildRows(tenantId: string, facilityId?: string): Promise<CatalogFeedRow[]> {
    return this.prisma.withTenant(async (tx) => {
      const [tenant, facilities, unitTypes, grouped] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
        tx.facility.findMany({
          where: {
            tenantId,
            deletedAt: null,
            isActive: true,
            ...(facilityId ? { id: facilityId } : {}),
          },
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            postalCode: true,
            contactPhone: true,
            contactEmail: true,
            publicSlug: true,
            images: true,
          },
          orderBy: { name: 'asc' },
        }),
        tx.unitType.findMany({
          where: { tenantId, isActive: true },
          select: { id: true, name: true, description: true, defaultPriceMonthly: true },
        }),
        tx.unit.groupBy({
          by: ['facilityId', 'unitTypeId'],
          where: { tenantId, status: 'available' },
          _count: { _all: true },
          _avg: { areaM2: true, volumeM3: true },
        }),
      ]);

      const availByPair = new Map<string, number>();
      const areaByPair = new Map<string, number | null>();
      const volumeByPair = new Map<string, number | null>();
      for (const g of grouped) {
        const key = `${g.facilityId}:${g.unitTypeId}`;
        availByPair.set(key, g._count._all);
        areaByPair.set(key, g._avg.areaM2 != null ? Number(g._avg.areaM2) : null);
        volumeByPair.set(key, g._avg.volumeM3 != null ? Number(g._avg.volumeM3) : null);
      }

      const rows: CatalogFeedRow[] = [];
      for (const f of facilities) {
        const photos = (f.images ?? []).map((key) => this.files.buildPublicUrl('public', key));
        const bookingUrl = tenant ? `${this.webBaseUrl}/book/${tenant.slug}` : `${this.webBaseUrl}`;
        for (const t of unitTypes) {
          const key = `${f.id}:${t.id}`;
          const available = availByPair.get(key) ?? 0;
          if (available === 0) continue;
          const areaM2 = areaByPair.get(key) ?? null;
          rows.push({
            facilityName: f.name,
            address: f.address ?? '',
            city: f.city ?? '',
            postalCode: f.postalCode ?? '',
            unitTypeName: t.name,
            description:
              t.description?.trim() ||
              `Trastero${areaM2 != null ? ` de ${areaM2.toFixed(1)} m²` : ''} en ${f.name}${f.city ? `, ${f.city}` : ''}. Acceso seguro y contratación online.`,
            areaM2,
            volumeM3: volumeByPair.get(key) ?? null,
            priceMonthly: Number(t.defaultPriceMonthly) * 1.21,
            available,
            phone: f.contactPhone ?? '',
            email: f.contactEmail ?? '',
            bookingUrl,
            photos,
          });
        }
      }
      return rows;
    }, tenantId);
  }
}
