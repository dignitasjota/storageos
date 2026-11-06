import { upcomingExceptions } from '@storageos/shared';

import type { AreaPageFaq, DayHours, PublicLandingFacilityDto } from '@storageos/shared';

const DAYS: [keyof PublicLandingFacilityDto['openingHours'], string][] = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

/** Los turnos de un día en schema.org, donde medianoche como cierre se escribe 23:59. */
function shifts(h: DayHours): { opens: string; closes: string }[] {
  const closes = (close: string) => (close === '00:00' ? '23:59' : close);
  return [
    { opens: h.open, closes: closes(h.close) },
    ...(h.open2 && h.close2 ? [{ opens: h.open2, closes: closes(h.close2) }] : []),
  ];
}

/** Horario del local en formato schema.org (solo los días abiertos). */
export function openingHoursSpecification(f: Pick<PublicLandingFacilityDto, 'openingHours'>) {
  return DAYS.flatMap(([key, day]) => {
    const h = f.openingHours?.[key];
    return h
      ? shifts(h).map((s) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: day, ...s }))
      : [];
  });
}

/** Festivos y días con otro horario que vienen; cerrado se escribe 00:00–00:00. */
function specialHoursSpecification(
  f: Pick<PublicLandingFacilityDto, 'openingExceptions' | 'timezone'>,
) {
  return upcomingExceptions(f.openingExceptions ?? [], f.timezone).flatMap((e) =>
    (e.hours ? shifts(e.hours) : [{ opens: '00:00', closes: '00:00' }]).map((s) => ({
      '@type': 'OpeningHoursSpecification',
      validFrom: e.date,
      validThrough: e.date,
      ...s,
    })),
  );
}

/**
 * Lo que Google usa para el negocio local: dirección, coordenadas, horario,
 * mapa y zonas a las que da servicio.
 */
export function localBusinessFields(
  f: PublicLandingFacilityDto,
  opts: { areaServed?: string[] } = {},
) {
  const hours = openingHoursSpecification(f);
  const specialHours = specialHoursSpecification(f);
  const hasGeo = f.latitude != null && f.longitude != null;
  const areas = [...new Set([f.city, ...(opts.areaServed ?? [])].filter((a): a is string => !!a))];
  return {
    ...(f.address || f.city
      ? {
          address: {
            '@type': 'PostalAddress',
            ...(f.address ? { streetAddress: f.address } : {}),
            ...(f.city ? { addressLocality: f.city } : {}),
            ...(f.postalCode ? { postalCode: f.postalCode } : {}),
            addressCountry: 'ES',
          },
        }
      : {}),
    ...(hasGeo
      ? {
          geo: { '@type': 'GeoCoordinates', latitude: f.latitude, longitude: f.longitude },
          hasMap: f.mapsUrl ?? `https://www.google.com/maps?q=${f.latitude},${f.longitude}`,
        }
      : f.mapsUrl
        ? { hasMap: f.mapsUrl }
        : {}),
    ...(hours.length > 0 ? { openingHoursSpecification: hours } : {}),
    ...(specialHours.length > 0 ? { specialOpeningHoursSpecification: specialHours } : {}),
    ...(areas.length > 0 ? { areaServed: areas.map((name) => ({ '@type': 'City', name })) } : {}),
    ...(f.contactPhone ? { telephone: f.contactPhone } : {}),
    ...(f.contactEmail ? { email: f.contactEmail } : {}),
  };
}

/** Preguntas visibles en la página como `FAQPage` (deben coincidir con lo que se ve). */
export function faqPageLd(faqs: AreaPageFaq[], id: string) {
  return faqs.length === 0
    ? null
    : {
        '@type': 'FAQPage',
        '@id': id,
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      };
}
