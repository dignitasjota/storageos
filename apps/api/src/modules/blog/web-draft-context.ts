import { type PublicLandingDto } from '@storageos/shared';

import { formatEur } from '../../common/format';
import { BLOG_POST_DRAFT_MARKER, PROMO_LANDING_DRAFT_MARKER } from '../ai/web-draft-stubs';

type Facility = PublicLandingDto['facilities'][number];

/** Precio con IVA de un tamaño, como lo ve el cliente en la web. */
function priceText(u: Facility['unitTypes'][number]): string {
  const gross = u.priceMonthly * (1 + u.taxRate / 100);
  return `${formatEur(gross)}/mes${u.taxRate > 0 ? ' IVA incl.' : ''}`;
}

/** Datos reales del negocio para el modelo: locales, ciudades, tamaños y precios con IVA. */
export function businessFacts(
  site: PublicLandingDto,
  filter: { facilityIds?: string[]; unitTypeIds?: string[] } = {},
): string {
  const facilities = site.facilities.filter(
    (f) => !filter.facilityIds?.length || filter.facilityIds.includes(f.id),
  );
  const lines = facilities.map((f) => {
    const sizes = f.unitTypes
      .filter((u) => !filter.unitTypeIds?.length || filter.unitTypeIds.includes(u.id))
      .map((u) => {
        const area = u.areaM2 ? `${String(u.areaM2).replace('.', ',')} m², ` : '';
        return `${u.name} (${area}${priceText(u)}${u.available > 0 ? '' : ', agotado ahora'})`;
      })
      .join('; ');
    const where = [f.address, f.postalCode, f.city].filter(Boolean).join(', ');
    return [
      `- ${f.name}`,
      `  Dirección: ${where || 'sin dirección publicada'}`,
      `  Tamaños y precios: ${sizes || 'sin tamaños publicados'}`,
    ].join('\n');
  });
  const cities = [...new Set(facilities.map((f) => f.city).filter(Boolean))];
  return [
    `Empresa: ${site.tenantName}.`,
    cities.length > 0 ? `Ciudades: ${cities.join(', ')}.` : '',
    'Locales:',
    ...(lines.length > 0 ? lines : ['- (sin locales publicados)']),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Instrucciones del borrador de una entrada del blog (la marca la reconoce el simulador). */
export const BLOG_POST_DRAFT_SYSTEM = `${BLOG_POST_DRAFT_MARKER} para la web de una empresa de alquiler de trasteros en España, para que salgan en Google y ayuden a quien busca un trastero.

Reglas:
- Español de España, tono cercano y claro, útil de verdad. Nada de relleno.
- Usa SOLO los datos que te dan (locales, ciudades, tamaños, precios). No inventes servicios, ofertas, horarios ni precios.
- contentMarkdown: entre 500 y 900 palabras en Markdown, con subtítulos (##), listas cuando ayuden y párrafos cortos. No pongas el título como encabezado (#): ya sale aparte.
- Cuando encaje, añade en una línea propia [[tamanos]] (tabla de tamaños y precios reales) o [[calculadora]] (calculadora de espacio). Como mucho una vez cada uno.
- Usa las palabras clave de forma natural, sin repetirlas en exceso.
- title: como máximo 70 caracteres. excerpt: una o dos frases (máximo 300 caracteres).
- seoTitle: como máximo 60 caracteres. seoDescription: como máximo 155 caracteres, con una llamada a la acción.

Responde SOLO con un objeto JSON con las claves title, excerpt, contentMarkdown, seoTitle y seoDescription.`;

/** Instrucciones del borrador de una landing de promoción (la marca la reconoce el simulador). */
export const PROMO_LANDING_DRAFT_SYSTEM = `${PROMO_LANDING_DRAFT_MARKER} para la web de una empresa de alquiler de trasteros en España.

Reglas:
- Español de España, directo y persuasivo, sin exagerar ni prometer lo que no está en la oferta.
- Usa SOLO los datos que te dan (la oferta, el cupón, los locales, tamaños y precios). No inventes descuentos, plazos ni condiciones distintas de las de la oferta.
- headline: como máximo 80 caracteres, con la ventaja principal.
- subheadline: una o dos frases (máximo 300 caracteres).
- benefits: entre 3 y 6 ventajas, cada una con title (máximo 40 caracteres) y description (una frase, máximo 160).
- conditions: entre 2 y 8 condiciones claras de la promoción (una frase cada una), basadas en la oferta. Si la oferta no dice algo, no lo inventes.
- seoTitle: como máximo 60 caracteres. seoDescription: como máximo 155 caracteres.

Responde SOLO con un objeto JSON con las claves headline, subheadline, benefits (lista de {title, description}), conditions (lista de textos), seoTitle y seoDescription.`;
