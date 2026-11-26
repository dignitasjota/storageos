import { Ga4Client } from './ga4.client';

import type { PrismaAdminService } from '../../database/prisma-admin.service';

/**
 * Por qué una propiedad de GA4 no se puede dar por del negocio, o null si lo
 * es: el negocio tiene puesto su ID de medición (Configuración → Marca y
 * SEO), no lo usa ninguna otra cuenta y es uno de los flujos web de la
 * propiedad. La cuenta de servicio es la misma para todos: sin esto, un
 * negocio podría leer los datos de otro. Lo usan Marketing (GA4 de la web) y
 * SEO Avanzado (GA4 del tráfico orgánico, PR 12).
 */
export async function ga4OwnershipProblem(
  admin: PrismaAdminService,
  client: Ga4Client,
  tenantId: string,
  propertyId: string,
): Promise<{ code: string; message: string } | null> {
  const tenant = await admin.tenant.findUnique({
    where: { id: tenantId },
    select: { googleAnalyticsId: true },
  });
  const measurementId = tenant?.googleAnalyticsId?.trim().toUpperCase();
  if (!measurementId) {
    return {
      code: 'ga4_measurement_id_required',
      message:
        'Antes, pon el ID de medición de Google Analytics de tu web (G-…) en Configuración → Marca y SEO: sirve para comprobar que la propiedad es tuya.',
    };
  }
  const shared = await admin.tenant.count({
    where: {
      id: { not: tenantId },
      deletedAt: null,
      googleAnalyticsId: { equals: measurementId, mode: 'insensitive' },
    },
  });
  if (shared > 0) {
    return {
      code: 'ga4_measurement_id_shared',
      message: `El ID de medición ${measurementId} lo usa otra cuenta de TrasterOS: no se puede comprobar que la propiedad sea tuya. Escríbenos a soporte.`,
    };
  }
  let ids: string[];
  try {
    ids = await client.measurementIds(propertyId);
  } catch (err) {
    return {
      code: 'ga4_property_unverified',
      message: `No se ha podido comprobar la propiedad en Google Analytics (${err instanceof Error ? err.message : String(err)}). Inténtalo más tarde.`,
    };
  }
  if (!ids.includes(measurementId)) {
    return {
      code: 'ga4_property_mismatch',
      message: `La propiedad ${propertyId} no mide tu web: ninguno de sus flujos tiene el ID de medición ${measurementId}, el que tienes en Configuración → Marca y SEO.`,
    };
  }
  return null;
}
