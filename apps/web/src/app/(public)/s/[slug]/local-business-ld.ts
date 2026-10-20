import type { AreaPageFaq, PublicLandingFacilityDto } from '@storageos/shared';

const DAYS: [keyof PublicLandingFacilityDto['openingHours'], string][] = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

/** Horario del local en formato schema.org (solo los días abiertos). */
export function openingHoursSpecification(f: Pick<PublicLandingFacilityDto, 'openingHours'>) {
  return DAYS.flatMap(([key, day]) => {
    const h = f.openingHours?.[key];
    return h
      ? [{ '@type': 'OpeningHoursSpecification', dayOfWeek: day, opens: h.open, closes: h.close }]
      : [];
  });
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
          hasMap: `https://www.google.com/maps?q=${f.latitude},${f.longitude}`,
        }
      : {}),
    ...(hours.length > 0 ? { openingHoursSpecification: hours } : {}),
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
