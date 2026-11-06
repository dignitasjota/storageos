import {
  COMPETITOR_FEATURE_LABELS,
  dayHoursText,
  upcomingExceptions,
  type CompetitorFeature,
  type DayHours,
  type PublicLandingDto,
} from '@storageos/shared';

/**
 * Información PÚBLICA del negocio para los asistentes que hablan con
 * desconocidos (WhatsApp y el chat de la web): locales con dirección, teléfono
 * y horario, tamaños con precio con IVA y disponibilidad, promoción activa y
 * preguntas frecuentes publicadas. Nada interno ni de inquilinos.
 * `codes` numera locales y tamaños (`[L1-T2]`) para que el modelo pueda
 * referirse a ellos al preparar una reserva.
 */
export function publicBusinessContextLines(args: {
  landing: PublicLandingDto | null;
  faqs: { question: string; answer: string }[];
  codes?: boolean;
}): string[] {
  const lines: string[] = [];
  const l = args.landing;
  const code = (s: string) => (args.codes ? `[${s}] ` : '');
  if (l) {
    lines.push('', '## Locales');
    for (const [fi, f] of l.facilities.entries()) {
      const hours = Object.entries(f.openingHours ?? {})
        .map(
          ([day, h]) =>
            `${day}: ${dayHoursText(h as DayHours | null, { closed: 'cerrado', allDay: '24 horas', and: 'y' })}`,
        )
        .join(', ');
      const special = upcomingExceptions(f.openingExceptions ?? [], f.timezone)
        .map(
          (e) =>
            `${e.date}${e.label ? ` (${e.label})` : ''}: ${dayHoursText(e.hours, {
              closed: 'cerrado',
              allDay: '24 horas',
              and: 'y',
            })}`,
        )
        .join(', ');
      const features = f.features
        .map((key) => COMPETITOR_FEATURE_LABELS[key as CompetitorFeature])
        .filter(Boolean)
        .join(', ');
      lines.push(
        `- ${code(`L${fi + 1}`)}${f.name}${f.address ? `, ${f.address}` : ''}${f.city ? ` (${f.city})` : ''}${
          f.contactPhone ? ` · tel. ${f.contactPhone}` : ''
        }${hours ? ` · horario de atención: ${hours}` : ''}${
          special ? ` · días especiales: ${special}` : ''
        }${features ? ` · características: ${features}` : ''}${
          f.directions ? ` · cómo llegar: ${f.directions}` : ''
        }`,
      );
      for (const [ti, t] of f.unitTypes.entries()) {
        const price = (t.priceMonthly * (1 + t.taxRate / 100)).toFixed(2).replace('.', ',');
        lines.push(
          `  · ${code(`L${fi + 1}-T${ti + 1}`)}${t.name}${t.areaM2 ? ` (unos ${t.areaM2} m²)` : ''}: ${price} €/mes · ${
            t.available > 0
              ? `${t.available} libres`
              : 'agotado (se puede apuntar a la lista de espera en la web)'
          }`,
        );
      }
    }
    if (l.activePromotion) {
      const p = l.activePromotion;
      const value =
        p.discountType === 'percentage'
          ? `${p.discountValue} % de descuento`
          : p.discountType === 'fixed'
            ? `${p.discountValue} € de descuento`
            : `${p.discountValue} meses gratis`;
      lines.push('', `## Promoción activa\n${p.name}: ${value} con el código ${p.code}.`);
    }
  }
  if (args.faqs.length > 0) {
    lines.push('', '## Preguntas frecuentes');
    for (const q of args.faqs) lines.push(`P: ${q.question}\nR: ${q.answer}`);
  }
  return lines;
}

/**
 * Códigos de los tamaños en el contexto del asistente: `L<n>-T<m>` (local n,
 * tipo m, en el orden de la web). Así el modelo no maneja ids.
 */
export function bookingCodes(
  landing: PublicLandingDto,
): Map<
  string,
  { facilityId: string; facilityName: string; unitTypeId: string; unitTypeName: string }
> {
  const out = new Map<
    string,
    { facilityId: string; facilityName: string; unitTypeId: string; unitTypeName: string }
  >();
  landing.facilities.forEach((f, fi) => {
    f.unitTypes.forEach((t, ti) => {
      out.set(`L${fi + 1}-T${ti + 1}`, {
        facilityId: f.id,
        facilityName: f.name,
        unitTypeId: t.id,
        unitTypeName: t.name,
      });
    });
  });
  return out;
}
