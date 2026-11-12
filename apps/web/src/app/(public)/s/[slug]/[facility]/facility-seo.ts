import { dayHoursText, hasOpeningHours } from '@storageos/shared';

import { intlLocaleFor, type PublicWebLocale } from '../i18n/messages';
import { formatPrice, grossPrice } from '../price-format';

import type { AreaPageFaq, PublicLandingFacilityDto } from '@storageos/shared';

/**
 * Textos SEO de la ficha de un local, sacados de sus datos (localidad,
 * dirección, tamaños, precio, características y horario). Puro: lo usan los
 * metadatos (servidor) y la página (cliente). Sirven cuando el negocio no ha
 * escrito el texto de su zona; si lo ha escrito, manda el suyo.
 */

/** Traductor del espacio `publicWeb` (el del cliente o el del servidor). */
export type PublicWebT = (key: string, values?: Record<string, string | number>) => string;

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** El nombre del local ya dice la localidad (o es la marca): no se repite. */
export function nameRedundant(
  f: Pick<PublicLandingFacilityDto, 'name' | 'city'>,
  tenantName: string,
): boolean {
  const name = norm(f.name);
  return (!!f.city && name.includes(norm(f.city))) || name === norm(tenantName);
}

/** Desde cuánto, con IVA: el tamaño más barato que queda (o el más barato si no queda ninguno). */
export function facilityPriceFrom(
  f: Pick<PublicLandingFacilityDto, 'unitTypes'>,
  locale: PublicWebLocale,
): string | null {
  const pool = f.unitTypes.filter((u) => u.available > 0);
  const list = pool.length > 0 ? pool : f.unitTypes;
  if (list.length === 0) return null;
  return formatPrice(Math.min(...list.map(grossPrice)), locale);
}

const m2 = (n: number, locale: PublicWebLocale) =>
  n.toLocaleString(intlLocaleFor(locale), { maximumFractionDigits: 1 });

/** «2 a 15 m²» (o «6 m²» con un solo tamaño); null sin medidas. */
export function facilitySizes(
  t: PublicWebT,
  f: Pick<PublicLandingFacilityDto, 'unitTypes'>,
  locale: PublicWebLocale,
): string | null {
  const areas = f.unitTypes.map((u) => u.areaM2).filter((a): a is number => a !== null && a > 0);
  if (areas.length === 0) return null;
  const min = Math.min(...areas);
  const max = Math.max(...areas);
  return Math.abs(max - min) < 0.05
    ? t('facility.sizesOne', { min: m2(min, locale) })
    : t('facility.sizesRange', { min: m2(min, locale), max: m2(max, locale) });
}

function joinList(items: string[], locale: PublicWebLocale): string {
  return new Intl.ListFormat(intlLocaleFor(locale), { type: 'conjunction' }).format(items);
}

/** Las características, en minúscula y en una frase («acceso 24 h y videovigilancia»). */
function featureList(t: PublicWebT, features: string[], locale: PublicWebLocale): string | null {
  // En minúscula dentro de la frase, salvo siglas (CCTV).
  const labels = features.map((k) => {
    const label = t(`features.${k}`);
    return /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
  });
  return labels.length > 0 ? joinList(labels, locale) : null;
}

/** «calle Regatxo, 10, 46920 Mislata»: el código postal y la localidad si no los lleva ya. */
export function facilityAddress(
  f: Pick<PublicLandingFacilityDto, 'address' | 'postalCode' | 'city'>,
): string | null {
  if (!f.address) return null;
  const has = (part: string | null) => !part || norm(f.address!).includes(norm(part));
  const tail = [has(f.postalCode) ? null : f.postalCode, has(f.city) ? null : f.city]
    .filter(Boolean)
    .join(' ');
  return tail ? `${f.address}, ${tail}` : f.address;
}

/** Horario de la semana en una línea, juntando los días seguidos iguales. */
export function hoursSummary(
  t: PublicWebT,
  f: Pick<PublicLandingFacilityDto, 'openingHours' | 'features'>,
  locale: PublicWebLocale,
): string | null {
  if (f.features.includes('24h')) return null;
  if (!hasOpeningHours(f.openingHours)) return null;
  const labels = { closed: t('hours.closed'), allDay: t('hours.allDay'), and: t('hours.and') };
  const day = (k: (typeof DAY_KEYS)[number]) => {
    const name = t(`hours.${k}`);
    return locale === 'es' ? name.toLowerCase() : name;
  };
  const groups: { from: (typeof DAY_KEYS)[number]; to: (typeof DAY_KEYS)[number]; text: string }[] =
    [];
  for (const k of DAY_KEYS) {
    const text = dayHoursText(f.openingHours[k], labels);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = k;
    else groups.push({ from: k, to: k, text });
  }
  return groups
    .map((g) =>
      g.from === g.to
        ? `${day(g.from)}, ${g.text.toLowerCase()}`
        : `${t('facility.daysRange', { from: day(g.from), to: day(g.to) })}, ${g.text.toLowerCase()}`,
    )
    .join('; ');
}

/**
 * Párrafo de presentación con la localidad: dónde está, qué tamaños y desde
 * cuánto, qué tiene y cómo se reserva.
 */
export function facilityIntro(
  t: PublicWebT,
  f: PublicLandingFacilityDto,
  tenantName: string,
  locale: PublicWebLocale,
  city: string | null,
): string {
  const address = facilityAddress(f);
  const named = !nameRedundant(f, tenantName);
  const place = !city
    ? t('facility.introPlaceNoCity', { name: f.name })
    : address
      ? t(named ? 'facility.introPlaceNamed' : 'facility.introPlace', {
          city,
          name: f.name,
          address,
        })
      : t(named ? 'facility.introPlaceNamedNoAddress' : 'facility.introPlaceNoAddress', {
          city,
          name: f.name,
        });
  const sizes = facilitySizes(t, f, locale);
  const price = facilityPriceFrom(f, locale);
  const offer =
    sizes && price
      ? t('facility.introSizesPrice', { sizes, price })
      : sizes
        ? t('facility.introSizes', { sizes })
        : price
          ? t('facility.introPrice', { price })
          : null;
  const features = featureList(t, f.features, locale);
  return [
    place,
    offer,
    features ? t('facility.introFeatures', { features }) : null,
    t('facility.introBooking'),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Preguntas de la ficha con sus datos (precio, dónde está, horario, reserva). */
export function facilityFaqs(
  t: PublicWebT,
  f: PublicLandingFacilityDto,
  tenantName: string,
  locale: PublicWebLocale,
): AreaPageFaq[] {
  const place =
    f.city && !nameRedundant(f, tenantName) ? `${f.name} (${f.city})` : (f.city ?? f.name);
  const out: AreaPageFaq[] = [];
  const price = facilityPriceFrom(f, locale);
  const sizes = facilitySizes(t, f, locale);
  if (price) {
    out.push({
      question: t('facility.faqPriceQ', { place }),
      answer: sizes
        ? t('facility.faqPriceASizes', { place, price, sizes })
        : t('facility.faqPriceA', { place, price }),
    });
  }
  const address = facilityAddress(f);
  if (address) {
    const directions = f.directions?.trim().replace(/\s+/g, ' ').slice(0, 300);
    out.push({
      question: t('facility.faqWhereQ', { place }),
      answer: [t('facility.faqWhereA', { address }), directions].filter(Boolean).join(' '),
    });
  }
  const hours = hoursSummary(t, f, locale);
  if (f.features.includes('24h') || hours) {
    out.push({
      question: t('facility.faqHoursQ', { place }),
      answer: hours ? t('facility.faqHoursA', { hours }) : t('facility.faqHours24'),
    });
  }
  out.push({ question: t('city.q3'), answer: t('city.a3') });
  return out;
}

/** Las propias primero y después las generadas que no repiten pregunta. */
export function mergeFaqs(own: AreaPageFaq[], generated: AreaPageFaq[]): AreaPageFaq[] {
  const seen = new Set(own.map((f) => norm(f.question)));
  return [...own, ...generated.filter((f) => !seen.has(norm(f.question)))];
}

/** Título para Google (≈60 caracteres): localidad, local si aporta, precio y marca. */
export function facilityTitle(
  f: PublicLandingFacilityDto,
  tenantName: string,
  locale: PublicWebLocale,
): string {
  const price = facilityPriceFrom(f, locale);
  const showName = !nameRedundant(f, tenantName);
  const en = locale === 'en';
  const head = f.city
    ? `${en ? 'Storage units in' : 'Trasteros en'} ${f.city}${showName ? ` (${f.name})` : ''}`
    : `${en ? 'Storage units' : 'Trasteros'} — ${f.name}`;
  const withPrice = price
    ? `${head} ${en ? 'from' : 'desde'} ${price}/${en ? 'month' : 'mes'}`
    : head;
  const full = `${withPrice} · ${tenantName}`;
  // Sin el precio si se pasa mucho (Google corta hacia los 60).
  return full.length <= 65 || !price ? full : `${head} · ${tenantName}`;
}

/** Descripción para Google (≤160): dónde, tamaños, precio, 24 h y reserva online. */
export function facilityDescription(
  t: PublicWebT,
  f: PublicLandingFacilityDto,
  tenantName: string,
  locale: PublicWebLocale,
): string {
  const en = locale === 'en';
  const address = facilityAddress(f);
  const sizes = facilitySizes(t, f, locale);
  const price = facilityPriceFrom(f, locale);
  const showName = !nameRedundant(f, tenantName);
  const lead = f.city
    ? `${en ? 'Storage units in' : 'Trasteros en'} ${f.city}${showName ? ` — ${f.name}` : ''}`
    : `${en ? 'Storage units' : 'Trasteros'} — ${f.name}`;
  const offer = [
    sizes ? (en ? `Sizes of ${sizes}` : `Tamaños de ${sizes}`) : null,
    price ? (en ? `from ${price}/month (VAT incl.)` : `desde ${price}/mes (IVA incl.)`) : null,
  ]
    .filter(Boolean)
    .join(', ');
  const closing = [
    f.features.includes('24h') ? (en ? '24-hour access' : 'Acceso 24 h') : null,
    en ? 'Book online in minutes' : 'Reserva online en minutos',
  ]
    .filter(Boolean)
    .join('. ');
  const sentence = (parts: (string | null)[]) =>
    parts
      .filter(Boolean)
      .map((p) => `${p}.`)
      .join(' ');
  const candidates = [
    sentence([address ? `${lead}: ${address}` : lead, offer || null, closing]),
    sentence([lead, offer || null, closing]),
    sentence([lead, closing]),
  ];
  return (
    candidates.find((c) => c.length <= 160) ?? candidates[candidates.length - 1]!.slice(0, 160)
  );
}
