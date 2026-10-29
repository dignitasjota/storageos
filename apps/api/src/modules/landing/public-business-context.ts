import type { PublicLandingDto } from '@storageos/shared';

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
        .map(([day, h]) => {
          const v = h as { open?: string; close?: string } | null;
          return `${day}: ${v?.open && v.close ? `${v.open}-${v.close}` : 'cerrado'}`;
        })
        .join(', ');
      lines.push(
        `- ${code(`L${fi + 1}`)}${f.name}${f.address ? `, ${f.address}` : ''}${f.city ? ` (${f.city})` : ''}${
          f.contactPhone ? ` · tel. ${f.contactPhone}` : ''
        }${hours ? ` · horario de atención: ${hours}` : ''}`,
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
