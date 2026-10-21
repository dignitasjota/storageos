import { type AreaPageKind, type PublicLandingDto } from '@storageos/shared';

import { formatEur } from '../../common/format';
import { AREA_PAGE_DRAFT_MARKER } from '../ai/stub-ai-provider';

type Facility = PublicLandingDto['facilities'][number];

const DAYS: [keyof NonNullable<Facility['openingHours']>, string][] = [
  ['mon', 'lunes'],
  ['tue', 'martes'],
  ['wed', 'miércoles'],
  ['thu', 'jueves'],
  ['fri', 'viernes'],
  ['sat', 'sábado'],
  ['sun', 'domingo'],
];

function hoursText(hours: Facility['openingHours']): string {
  if (!hours) return 'sin horario publicado';
  const parts = DAYS.map(([key, label]) => {
    const day = hours[key];
    return `${label} ${day ? `${day.open}–${day.close === '00:00' ? '24:00' : day.close}` : 'cerrado'}`;
  });
  return parts.join(', ');
}

function facilityText(f: Facility): string {
  const sizes = f.unitTypes
    .map((u) => {
      const gross = u.priceMonthly * (1 + u.taxRate / 100);
      const price = `${formatEur(gross)}/mes${u.taxRate > 0 ? ' IVA incl.' : ''}`;
      const area = u.areaM2 ? `${String(u.areaM2).replace('.', ',')} m², ` : '';
      return `${u.name} (${area}${price}${u.available > 0 ? '' : ', agotado ahora'})`;
    })
    .join('; ');
  return [
    `- ${f.name}`,
    `  Dirección: ${[f.address, f.postalCode, f.city].filter(Boolean).join(', ') || 'sin dirección publicada'}`,
    `  Horario: ${hoursText(f.openingHours)}`,
    `  Tamaños y precios: ${sizes || 'sin tamaños publicados'}`,
  ].join('\n');
}

/** Instrucciones del modelo (la marca la reconoce el simulador de los tests). */
export const AREA_PAGE_DRAFT_SYSTEM = `${AREA_PAGE_DRAFT_MARKER} para la web de una empresa de alquiler de trasteros en España, para que salga en Google en esa zona.

Reglas:
- Español de España, tono cercano y claro. Nada de relleno ni frases genéricas que valgan para cualquier sitio.
- Usa SOLO los datos que te dan (direcciones, horarios, tamaños, precios). No inventes servicios, ofertas, distancias exactas ni horarios. Si el horario no es 24 horas, no digas que lo es.
- Puedes citar barrios, pueblos colindantes y vías de acceso reales de la zona solo si estás seguro de que existen.
- La introducción (intro) tiene entre 180 y 260 palabras, en 2 o 3 párrafos separados por una línea en blanco. Nombra la zona de forma natural y explica para qué suele usarse un trastero allí (mudanzas, pisos pequeños, negocios, temporada…).
- nearbyAreas: entre 3 y 8 barrios o pueblos reales cercanos a los que da servicio el local.
- faqs: entre 3 y 5 preguntas propias de esta zona (cómo llegar, aparcar, qué tamaño elegir, precios…), con respuestas basadas en los datos.
- seoTitle: como máximo 60 caracteres, con la zona y el nombre de la empresa.
- seoDescription: como máximo 155 caracteres, con la zona, el precio más bajo y una llamada a reservar.
- nearestNote: solo en zonas sin local; una frase que diga cuál es el local más cercano y dónde está.

Responde SOLO con un objeto JSON con las claves intro, nearestNote, nearbyAreas, faqs (lista de {question, answer}), seoTitle y seoDescription.`;

/** Datos del negocio y de la zona para el borrador. */
export function areaPageDraftContext(args: {
  tenantName: string;
  zone: string;
  kind: AreaPageKind;
  facilities: Facility[];
  existingFaqs: string[];
}): string {
  const header =
    args.kind === 'city'
      ? `Página: trasteros en ${args.zone} (la empresa tiene local en esta ciudad).`
      : `Página: trasteros cerca de ${args.zone} (la empresa NO tiene local en ${args.zone}; estos son los más cercanos).`;
  return [
    `Empresa: ${args.tenantName}.`,
    header,
    '',
    'Locales:',
    ...args.facilities.map(facilityText),
    '',
    args.existingFaqs.length > 0
      ? `Preguntas que ya tiene la web (no las repitas): ${args.existingFaqs.join(' | ')}`
      : '',
    'Redacta la página.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
