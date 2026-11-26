import { z } from 'zod';

import { expectedCtr, isBrandQuery } from '../web/search-console';

import {
  normalizeSeoKeyword,
  type SeoDataOriginDto,
  type SeoKeywordIntent,
  type SeoProviderKey,
} from './sistrix';

/**
 * SEO Avanzado, PR 4: motor de oportunidades propio (§9, §18.6 y §19.3).
 * Reglas, no IA, con el motivo visible y una puntuación de 0 a 100 desglosada
 * por factores. Todo lo de este fichero es puro: el API reúne los datos con
 * agregaciones SQL y aquí se decide qué es una oportunidad y cuánto vale.
 */

// ------------------------------------------------------------------- tipos

export const SEO_OPPORTUNITY_TYPES = [
  'near_top3',
  'near_page1',
  'commercial_deep',
  'low_ctr',
  'rising',
  'falling',
  'demand_gap',
  'sistrix',
  'keyword_gap',
] as const;
export type SeoOpportunityType = (typeof SEO_OPPORTUNITY_TYPES)[number];
export const SeoOpportunityTypeEnum = z.enum(SEO_OPPORTUNITY_TYPES);

export const SEO_OPPORTUNITY_TYPE_LABELS: Record<SeoOpportunityType, string> = {
  near_top3: 'Cerca del top 3',
  near_page1: 'A un paso de la primera página',
  commercial_deep: 'Comercial lejos (21–50)',
  low_ctr: 'Mucho aparecer y poco clic',
  rising: 'Sube',
  falling: 'Baja',
  demand_gap: 'Demanda real frente a SISTRIX',
  sistrix: 'Oportunidad de SISTRIX',
  keyword_gap: 'La competencia sale y tú no',
};

/** Qué hacer con cada tipo (la acción sugerida). */
export const SEO_OPPORTUNITY_ACTIONS: Record<SeoOpportunityType, string> = {
  near_top3:
    'Mejora la página que sale: título con la búsqueda, texto más completo y enlaces desde otras páginas de tu web para entrar en el top 3.',
  near_page1:
    'Refuerza la página que sale (más contenido útil y enlaces internos) para entrar en la primera página de Google.',
  commercial_deep:
    'Es una búsqueda de alguien que quiere contratar: crea o adapta una página pensada para ella (precios, reserva, ubicación).',
  low_ctr:
    'Revisa el título y la descripción que enseña Google: que digan el precio, la ubicación o una ventaja clara para que den ganas de entrar.',
  rising:
    'Aprovecha que está subiendo: refuerza la página y enlázala desde las páginas con más visitas de tu web.',
  falling:
    'Mira qué ha cambiado en la página (texto, título, enlaces) y qué han hecho tus competidores en esa búsqueda.',
  demand_gap:
    'Fíjate en tus impresiones reales, no en el volumen de SISTRIX: trabaja la página que sale para esta búsqueda.',
  sistrix:
    'Revisa la página que posiciona y mejórala: SISTRIX estima que ganarías visitas subiendo unos puestos.',
  keyword_gap:
    'Valora crear una página para esta búsqueda o cubrirla en una que ya tengas: tus competidores la trabajan y tú no sales.',
};

export const SEO_OPPORTUNITY_STATUSES = [
  'new',
  'seen',
  'in_progress',
  'done',
  'dismissed',
] as const;
export type SeoOpportunityStatus = (typeof SEO_OPPORTUNITY_STATUSES)[number];
export const SeoOpportunityStatusEnum = z.enum(SEO_OPPORTUNITY_STATUSES);
export const SEO_OPPORTUNITY_STATUS_LABELS: Record<SeoOpportunityStatus, string> = {
  new: 'Nueva',
  seen: 'Vista',
  in_progress: 'En curso',
  done: 'Hecha',
  dismissed: 'Descartada',
};
/** Las que siguen pendientes (las que se enseñan por defecto). */
export const SEO_OPPORTUNITY_OPEN_STATUSES: SeoOpportunityStatus[] = ['new', 'seen', 'in_progress'];

/** De dónde salen los datos de una oportunidad. */
export type SeoOpportunitySource = 'gsc' | 'sistrix';
export const SEO_OPPORTUNITY_SOURCE_LABELS: Record<SeoOpportunitySource, string> = {
  gsc: 'Search Console (datos reales)',
  sistrix: 'SISTRIX (estimación)',
};

// ------------------------------------------------------ pesos y umbrales

/**
 * Pesos de la puntuación (§9: 25/20/20/15/10/10, más la dificultad, que
 * resta). Se guardan por proyecto en `seo_projects.weights` (lo que falte,
 * el valor por defecto).
 */
export const SEO_DEFAULT_WEIGHTS = {
  /** Demanda: impresiones reales o, sin ellas, el volumen de SISTRIX. */
  impressions: 0.25,
  /** Cerca del premio: cuanto más cerca del top 3, más vale el esfuerzo. */
  position: 0.2,
  /** Clics perdidos: CTR por debajo del esperado para su posición. */
  ctrGap: 0.2,
  /** Intención comercial o de visita (contratar, ir a un sitio). */
  business: 0.15,
  /** Prioridad que le das en tus palabras clave. */
  priority: 0.1,
  /** Tendencia frente al periodo anterior (sube o cae). */
  trend: 0.1,
  /** Dificultad (competencia de SISTRIX): resta. */
  difficulty: 0.1,
  /**
   * La página que sale convierte (reservas, contactos o altas desde Google,
   * PR 8). Opcional: solo entra cuando la página tiene clics suficientes y
   * conversiones medidas; si no, no cuenta (ni como desconocido), así que las
   * puntuaciones sin ese dato no cambian.
   */
  conversions: 0.05,
} as const;
export type SeoWeightKey = keyof typeof SEO_DEFAULT_WEIGHTS;
export type SeoWeights = Record<SeoWeightKey, number>;
export const SEO_WEIGHT_KEYS = Object.keys(SEO_DEFAULT_WEIGHTS) as SeoWeightKey[];
export const SEO_WEIGHT_LABELS: Record<SeoWeightKey, string> = {
  impressions: 'Demanda (impresiones o volumen)',
  position: 'Cerca del premio (posición)',
  ctrGap: 'Clics perdidos (CTR bajo)',
  business: 'Intención comercial',
  priority: 'Prioridad en tus palabras',
  trend: 'Tendencia',
  difficulty: 'Dificultad (resta)',
  conversions: 'La página convierte',
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Pesos guardados de un proyecto con los valores por defecto donde falten. */
export function seoWeightsOf(stored: unknown): SeoWeights {
  const out = { ...SEO_DEFAULT_WEIGHTS } as SeoWeights;
  if (stored && typeof stored === 'object') {
    for (const k of SEO_WEIGHT_KEYS) {
      const v = (stored as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp01(v);
    }
  }
  return out;
}

/** Umbrales del motor (editables por proyecto en `seo_projects.opportunity_settings`). */
export const SEO_DEFAULT_OPPORTUNITY_THRESHOLDS = {
  /** Días del periodo que se analiza (y del anterior con el que se compara). */
  periodDays: 28,
  /** Impresiones mínimas en el periodo para las posiciones 4–10 y 11–20. */
  minImpressions: 50,
  /** Impresiones mínimas de una comercial en 21–50. */
  commercialMinImpressions: 10,
  /** Impresiones mínimas para juzgar el CTR. */
  lowCtrMinImpressions: 100,
  /** CTR por debajo de esta parte del esperado (0,5 = la mitad). */
  lowCtrRatio: 0.5,
  /** Impresiones mínimas en los DOS periodos para hablar de subida o caída. */
  trendMinImpressions: 30,
  /** Puestos de cambio para que cuente como subida o caída. */
  trendMinPositions: 3,
  /** O un cambio de impresiones de al menos este % (con la posición a favor). */
  trendMinImpressionsPct: 50,
  /** Impresiones reales mínimas para «SISTRIX no ve esta demanda». */
  demandGapMinImpressions: 20,
  /** Volumen de SISTRIX a partir del cual se considera alto. */
  highVolume: 500,
  /** Con volumen alto, apareces poco si tus impresiones no llegan a esta parte del volumen. */
  lowShare: 0.05,
  /** Posición máxima de un competidor para «la competencia sale y tú no». */
  keywordGapMaxPosition: 20,
  /** Puntos que tiene que subir una descartada para que vuelva como nueva. */
  reappearPoints: 20,
} as const;
export type SeoOpportunityThresholdKey = keyof typeof SEO_DEFAULT_OPPORTUNITY_THRESHOLDS;
export type SeoOpportunityThresholds = Record<SeoOpportunityThresholdKey, number>;

/** Rango admitido de cada umbral. */
export const SEO_OPPORTUNITY_THRESHOLD_RANGES: Record<
  SeoOpportunityThresholdKey,
  { min: number; max: number; integer: boolean; label: string }
> = {
  periodDays: { min: 7, max: 90, integer: true, label: 'Días que se analizan' },
  minImpressions: { min: 0, max: 100_000, integer: true, label: 'Impresiones mínimas (4–20)' },
  commercialMinImpressions: {
    min: 0,
    max: 100_000,
    integer: true,
    label: 'Impresiones mínimas (comerciales 21–50)',
  },
  lowCtrMinImpressions: {
    min: 1,
    max: 100_000,
    integer: true,
    label: 'Impresiones mínimas para juzgar el CTR',
  },
  lowCtrRatio: { min: 0.1, max: 0.9, integer: false, label: 'CTR bajo: parte del esperado' },
  trendMinImpressions: {
    min: 1,
    max: 100_000,
    integer: true,
    label: 'Impresiones mínimas en cada periodo (suben o bajan)',
  },
  trendMinPositions: { min: 1, max: 50, integer: true, label: 'Puestos para que suba o baje' },
  trendMinImpressionsPct: {
    min: 10,
    max: 1000,
    integer: true,
    label: 'O cambio de impresiones (%)',
  },
  demandGapMinImpressions: {
    min: 1,
    max: 100_000,
    integer: true,
    label: 'Impresiones mínimas sin volumen en SISTRIX',
  },
  highVolume: { min: 10, max: 10_000_000, integer: true, label: 'Volumen alto (SISTRIX)' },
  lowShare: { min: 0.001, max: 1, integer: false, label: 'Apareces poco: parte del volumen' },
  keywordGapMaxPosition: {
    min: 1,
    max: 100,
    integer: true,
    label: 'Posición máxima del competidor',
  },
  reappearPoints: {
    min: 1,
    max: 100,
    integer: true,
    label: 'Puntos para que vuelva una descartada',
  },
};

/** Umbrales guardados con los valores por defecto donde falten o se salgan de rango. */
export function seoThresholdsOf(stored: unknown): SeoOpportunityThresholds {
  const out = { ...SEO_DEFAULT_OPPORTUNITY_THRESHOLDS } as SeoOpportunityThresholds;
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(SEO_OPPORTUNITY_THRESHOLD_RANGES) as SeoOpportunityThresholdKey[]) {
      const v = (stored as Record<string, unknown>)[k];
      const r = SEO_OPPORTUNITY_THRESHOLD_RANGES[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max) out[k] = v;
    }
  }
  return out;
}

const weightField = z.number().min(0).max(1);
const thresholdShape = Object.fromEntries(
  (Object.keys(SEO_OPPORTUNITY_THRESHOLD_RANGES) as SeoOpportunityThresholdKey[]).map((k) => {
    const r = SEO_OPPORTUNITY_THRESHOLD_RANGES[k];
    const base = z.number().min(r.min).max(r.max);
    return [k, (r.integer ? base.int() : base).optional()];
  }),
) as { [K in SeoOpportunityThresholdKey]: z.ZodOptional<z.ZodNumber> };

export const UpdateSeoOpportunitySettingsSchema = z
  .object({
    weights: z
      .object(
        Object.fromEntries(SEO_WEIGHT_KEYS.map((k) => [k, weightField.optional()])) as {
          [K in SeoWeightKey]: z.ZodOptional<z.ZodNumber>;
        },
      )
      .optional(),
    thresholds: z.object(thresholdShape).optional(),
    /** Vuelve a los pesos y umbrales por defecto (lo demás se ignora). */
    reset: z.boolean().optional(),
  })
  .refine(
    (v) =>
      !v.weights ||
      // La dificultad resta y «la página convierte» es opcional: no cuentan.
      SEO_WEIGHT_KEYS.filter((k) => k !== 'difficulty' && k !== 'conversions').some(
        (k) => v.weights?.[k] !== 0,
      ),
    { message: 'Al menos un peso (sin contar la dificultad) tiene que ser mayor que cero.' },
  );
export type UpdateSeoOpportunitySettingsInput = z.infer<typeof UpdateSeoOpportunitySettingsSchema>;

export interface SeoOpportunitySettingsDto {
  weights: SeoWeights;
  thresholds: SeoOpportunityThresholds;
  defaults: { weights: SeoWeights; thresholds: SeoOpportunityThresholds };
}

// ----------------------------------------------------------------- intención

/** De dónde sale la intención: lo que pusiste, lo que dice SISTRIX o reglas sobre el texto. */
export type SeoIntentSource = 'manual' | 'sistrix' | 'rules';
export const SEO_INTENT_SOURCE_LABELS: Record<SeoIntentSource, string> = {
  manual: 'puesta a mano',
  sistrix: 'según SISTRIX',
  rules: 'deducida del texto',
};

const DO_RE =
  /\b(precio|precios|tarifa|tarifas|alquil\w*|barat\w*|oferta\w*|reserv\w*|contrat\w*|presupuesto|comprar|cuanto cuesta|cuánto cuesta|cuanto vale|cuánto vale|econ[oó]mic\w*)\b/;
const VISIT_RE = /\b(cerca|cercano|cercanos|horario|horarios|direcci[oó]n|abierto|near me)\b/;
const KNOW_RE =
  /^(que|qué|como|cómo|cuando|cuándo|por que|por qué|porque|para que|para qué|cual|cuál|cuales|cuáles|diferencia|significado|tipos de|ventajas de|ideas)(?=\s|$)/;

/** Intención deducida del texto (reglas sencillas, §18.3). null si no se sabe. */
export function seoRuleIntent(query: string): SeoKeywordIntent | null {
  const q = normalizeSeoKeyword(query);
  if (DO_RE.test(q)) return 'do';
  if (KNOW_RE.test(q)) return 'know';
  if (VISIT_RE.test(q)) return 'visit';
  return null;
}

/** La intención dominante de los porcentajes de SISTRIX (null si no hay ninguno). */
export function seoSistrixIntent(
  p: {
    know: number | null;
    do: number | null;
    visit: number | null;
    website: number | null;
  } | null,
): SeoKeywordIntent | null {
  if (!p) return null;
  let best: SeoKeywordIntent | null = null;
  let max = 0;
  for (const k of ['do', 'visit', 'know', 'website'] as const) {
    const v = p[k] ?? 0;
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best;
}

/** Intención con su origen: primero la manual, luego SISTRIX y por último las reglas. */
export function seoResolveIntent(input: {
  manual: SeoKeywordIntent | null;
  sistrix: SeoKeywordIntent | null;
  query: string;
}): { value: SeoKeywordIntent; source: SeoIntentSource } | null {
  if (input.manual) return { value: input.manual, source: 'manual' };
  if (input.sistrix) return { value: input.sistrix, source: 'sistrix' };
  const rule = seoRuleIntent(input.query);
  return rule ? { value: rule, source: 'rules' } : null;
}

/**
 * Comercial: contratar o comprar (transaccional) y, en un negocio local como
 * el de los trasteros, ir a un sitio («trasteros valencia» es de visita).
 */
export const isCommercialIntent = (i: SeoKeywordIntent | null | undefined): boolean =>
  i === 'do' || i === 'visit';

// ------------------------------------------------------------------ formato

/** Miles con punto (sin depender del ICU del entorno). */
export function seoFmtInt(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return n < 0 ? `-${grouped}` : grouped;
}
function fmtDec(n: number, decimals = 1): string {
  const fixed = n.toFixed(decimals);
  const clean = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return clean.replace('.', ',');
}
const fmtPos = (n: number) => fmtDec(n, 1);
const fmtPct = (ratio: number) => `${fmtDec(ratio * 100, 1)} %`;

// ---------------------------------------------------------------- puntuación

/** Lo que entra en la puntuación (null = no se sabe). */
export interface SeoOpportunityFactorsInput {
  /** Impresiones reales del periodo (Search Console). */
  impressions: number | null;
  clicks: number | null;
  /** Volumen estimado de SISTRIX (búsquedas al mes). */
  volume: number | null;
  /** Visitas que SISTRIX estima que ganarías (sus oportunidades). */
  gain: number | null;
  position: number | null;
  ctr: number | null;
  intent: SeoKeywordIntent | null;
  /** Prioridad en tus palabras (1 alta · 2 media · 3 baja). */
  priority: number | null;
  /** Puestos que sube frente al periodo anterior (solo si son comparables). */
  positionDiff: number | null;
  impressionsPct: number | null;
  /** Competencia de SISTRIX (0–100). */
  competition: number | null;
  hasGsc: boolean;
  hasSistrix: boolean;
  /** El periodo anterior tiene datos de casi todos sus días. */
  comparable: boolean;
  /** Conversiones de Google de la página que sale y sus clics (opcional, PR 8). */
  pageConversions?: SeoPageConversionStat | null;
}

/** Conversiones orgánicas de una página y sus clics de Google en el mismo periodo. */
export interface SeoPageConversionStat {
  conversions: number;
  clicks: number;
}

/** Tasa de conversión que vale 1 en el factor «La página convierte» (5 %). */
export const SEO_CONVERSION_RATE_CAP = 0.05;
/** Clics mínimos de la página para que el factor cuente. */
export const SEO_CONVERSION_MIN_CLICKS = 20;

export interface SeoOpportunityFactorDto {
  key: SeoWeightKey;
  label: string;
  /** Peso configurado (0–1). */
  weight: number;
  /** Valor del factor (0–1); null = no se sabe (cuenta como `SEO_UNKNOWN_FACTOR_VALUE`). */
  value: number | null;
  /** Puntos que aporta (negativos en la dificultad). */
  points: number;
  /** En palabras. */
  detail: string;
}

export interface SeoOpportunityScoreDto {
  /** 0–100. */
  score: number;
  /** Confianza del dato (0–1): más con datos reales de Google que solo con SISTRIX. */
  confidence: number;
  factors: SeoOpportunityFactorDto[];
}

/**
 * Demanda: de 0 a 1 en escala logarítmica (5.000 impresiones, 10.000 búsquedas
 * al mes o 1.000 visitas que SISTRIX estima ganar = 1).
 */
export const SEO_DEMAND_IMPRESSIONS_CAP = 5000;
export const SEO_DEMAND_VOLUME_CAP = 10_000;
export const SEO_DEMAND_GAIN_CAP = 1000;
/**
 * Valor con el que cuenta un factor que no se sabe: neutro tirando a bajo. No
 * desaparece (repartir su peso inflaría las fichas con pocos datos).
 */
export const SEO_UNKNOWN_FACTOR_VALUE = 0.3;
/** Peso fijo y peso de la confianza en la puntuación: 100 · bruto · (0,4 + 0,6 · confianza). */
export const SEO_CONFIDENCE_FLOOR = 0.4;

const log01 = (n: number, cap: number) => clamp01(Math.log10(1 + n) / Math.log10(1 + cap));

/** Valor de la posición: lo más cerca del top 3 (sin estar en él) vale más. */
export function seoPositionValue(position: number): number {
  if (position < 3.5) return 0.3;
  if (position <= 10) return 1 - (position - 4) * 0.03;
  if (position <= 20) return 0.75 - (position - 11) * 0.03;
  if (position <= 50) return 0.4 - (position - 21) * 0.01;
  return 0.1;
}

const INTENT_VALUE: Record<SeoKeywordIntent, number> = {
  do: 1,
  visit: 0.8,
  website: 0.3,
  know: 0.2,
};
const PRIORITY_VALUE: Record<number, number> = { 1: 1, 2: 0.5, 3: 0.2 };
const INTENT_WORDS: Record<SeoKeywordIntent, string> = {
  do: 'contratar o comprar',
  visit: 'ir a un sitio',
  website: 'buscar una web',
  know: 'informarse',
};

/** Confianza: Google y SISTRIX 0,9; solo Google 0,75; solo SISTRIX 0,45; nada 0,2. */
export function seoConfidence(input: SeoOpportunityFactorsInput): number {
  let c =
    input.hasGsc && input.hasSistrix ? 0.9 : input.hasGsc ? 0.75 : input.hasSistrix ? 0.45 : 0.2;
  if (input.hasGsc && (input.impressions ?? 0) < 30) c -= 0.15;
  if (input.comparable && input.hasGsc) c += 0.1;
  return Math.round(clamp01(c) * 100) / 100;
}

/**
 * Puntuación de 0 a 100:
 *
 *   base = Σ peso·valor / Σ peso   (un factor que no se sabe vale 0,3)
 *   bruto = max(0, base − peso_dificultad · dificultad)
 *   puntuación = round(100 · bruto · (0,4 + 0,6 · confianza))
 *
 * Un factor que no se sabe (sin volumen, sin intención…) cuenta como un valor
 * bajo (`SEO_UNKNOWN_FACTOR_VALUE`) y además baja la confianza, que pesa
 * mucho: con datos reales de Google una oportunidad puntúa por encima de otra
 * parecida que solo tiene estimaciones de SISTRIX.
 */
export function scoreSeoOpportunity(
  input: SeoOpportunityFactorsInput,
  weights: SeoWeights = SEO_DEFAULT_WEIGHTS,
): SeoOpportunityScoreDto {
  const confidence = seoConfidence(input);
  const modulation = SEO_CONFIDENCE_FLOOR + (1 - SEO_CONFIDENCE_FLOOR) * confidence;

  let demand: { value: number | null; detail: string };
  if (input.impressions !== null && input.impressions > 0) {
    demand = {
      value: log01(input.impressions, SEO_DEMAND_IMPRESSIONS_CAP),
      detail: `${seoFmtInt(input.impressions)} impresiones reales en el periodo`,
    };
  } else if ((input.volume ?? 0) > 0 || (input.gain ?? 0) > 0) {
    const byVolume = (input.volume ?? 0) > 0 ? log01(input.volume!, SEO_DEMAND_VOLUME_CAP) : 0;
    const byGain = (input.gain ?? 0) > 0 ? log01(input.gain!, SEO_DEMAND_GAIN_CAP) : 0;
    const parts: string[] = [];
    if ((input.volume ?? 0) > 0) parts.push(`${seoFmtInt(input.volume!)} búsquedas al mes`);
    if ((input.gain ?? 0) > 0) parts.push(`${seoFmtInt(input.gain!)} visitas más`);
    demand = {
      value: Math.max(byVolume, byGain),
      detail: `Estimación de SISTRIX: ${parts.join(' y ')}`,
    };
  } else if (input.impressions === 0 || input.volume === 0) {
    demand = { value: 0, detail: 'Sin demanda medida' };
  } else {
    demand = { value: null, detail: 'Demanda desconocida: cuenta como baja' };
  }

  const position =
    input.position !== null
      ? {
          value: seoPositionValue(input.position),
          detail: `Posición ${fmtPos(input.position)}`,
        }
      : { value: 0.1, detail: 'Tu web no sale' };

  let ctrGap: { value: number | null; detail: string } = {
    value: null,
    detail: 'Sin datos de clics de Google: desconocido, cuenta como bajo',
  };
  if (
    input.hasGsc &&
    input.position !== null &&
    input.ctr !== null &&
    (input.impressions ?? 0) > 0
  ) {
    const expected = expectedCtr(input.position);
    const lost = clamp01((expected - input.ctr) / expected);
    ctrGap = {
      value: lost,
      detail:
        lost > 0
          ? `CTR ${fmtPct(input.ctr)} frente al ${fmtPct(expected)} esperado en su posición`
          : `CTR ${fmtPct(input.ctr)}, en lo esperado o por encima`,
    };
  }

  const business = input.intent
    ? {
        value: INTENT_VALUE[input.intent],
        detail: `Intención: ${INTENT_WORDS[input.intent]}`,
      }
    : { value: null, detail: 'Intención desconocida: cuenta como baja' };

  const priority =
    input.priority !== null && PRIORITY_VALUE[input.priority] !== undefined
      ? {
          value: PRIORITY_VALUE[input.priority]!,
          detail: `Prioridad ${input.priority === 1 ? 'alta' : input.priority === 2 ? 'media' : 'baja'} en tus palabras`,
        }
      : { value: null, detail: 'No está en tus palabras: desconocida, cuenta como baja' };

  let trend: { value: number | null; detail: string } = {
    value: null,
    detail: 'Sin periodo anterior comparable: desconocida, cuenta como baja',
  };
  if (input.comparable && (input.positionDiff !== null || input.impressionsPct !== null)) {
    const pd = input.positionDiff ?? 0;
    const ip = input.impressionsPct ?? 0;
    trend = {
      value: clamp01(Math.min(1, Math.abs(pd) / 10) * 0.7 + Math.min(1, Math.abs(ip) / 100) * 0.3),
      detail:
        pd > 0
          ? `Sube ${fmtPos(pd)} puestos frente al periodo anterior`
          : pd < 0
            ? `Baja ${fmtPos(-pd)} puestos frente al periodo anterior`
            : 'Misma posición que en el periodo anterior',
    };
  }

  const difficulty =
    input.competition !== null
      ? {
          value: clamp01(input.competition / 100),
          detail: `Competencia ${seoFmtInt(input.competition)}/100 según SISTRIX`,
        }
      : { value: null, detail: 'Competencia desconocida: no resta' };

  const positives: [SeoWeightKey, { value: number | null; detail: string }][] = [
    ['impressions', demand],
    ['position', position],
    ['ctrGap', ctrGap],
    ['business', business],
    ['priority', priority],
    ['trend', trend],
  ];
  // La página convierte: solo con datos (si no, el factor no existe y nada cambia).
  const pc = input.pageConversions;
  if (pc && pc.clicks >= SEO_CONVERSION_MIN_CLICKS && pc.conversions > 0) {
    const rate = pc.conversions / pc.clicks;
    positives.push([
      'conversions',
      {
        value: clamp01(rate / SEO_CONVERSION_RATE_CAP),
        detail: `La página que sale convierte: ${seoFmtInt(pc.conversions)} de ${seoFmtInt(pc.clicks)} clics desde Google (${fmtPct(rate)})`,
      },
    ]);
  }
  const valueOf = (f: { value: number | null }) => f.value ?? SEO_UNKNOWN_FACTOR_VALUE;
  const sumW = positives.reduce((s, [k]) => s + weights[k], 0);
  const base =
    sumW > 0 ? positives.reduce((s, [k, f]) => s + weights[k] * valueOf(f), 0) / sumW : 0;
  const penalty = difficulty.value !== null ? weights.difficulty * difficulty.value : 0;
  const raw = Math.max(0, base - penalty);
  const score = Math.max(0, Math.min(100, Math.round(100 * raw * modulation)));

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const factors: SeoOpportunityFactorDto[] = positives.map(([k, f]) => ({
    key: k,
    label: SEO_WEIGHT_LABELS[k],
    weight: weights[k],
    value: f.value === null ? null : Math.round(f.value * 1000) / 1000,
    points:
      sumW > 0 && weights[k] > 0 ? round1((100 * weights[k] * valueOf(f) * modulation) / sumW) : 0,
    detail: f.detail,
  }));
  factors.push({
    key: 'difficulty',
    label: SEO_WEIGHT_LABELS.difficulty,
    weight: weights.difficulty,
    value: difficulty.value === null ? null : Math.round(difficulty.value * 1000) / 1000,
    points: penalty > 0 ? -round1(100 * penalty * modulation) : 0,
    detail: difficulty.detail,
  });
  return { score, confidence, factors };
}

// --------------------------------------------------------------- detección

/** Una búsqueda de Search Console con sus sumas del periodo y del anterior. */
export interface SeoOpportunityQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  /** Posición media ponderada (null sin filas). */
  position: number | null;
  /** null si el periodo anterior no es comparable o la búsqueda no salía. */
  previous: { clicks: number; impressions: number; position: number | null } | null;
}

/** Una palabra de tus palabras clave o con métricas de SISTRIX. */
export interface SeoOpportunityKeywordRow {
  keyword: string;
  /** Está en tus palabras clave. */
  inCatalog: boolean;
  intent: SeoKeywordIntent | null;
  priority: number | null;
  targetUrl: string | null;
  /** Métricas de SISTRIX (null si no se han pedido). */
  metrics: {
    volume: number | null;
    competition: number | null;
    cpc: number | null;
    intent: SeoKeywordIntent | null;
    origin: SeoDataOriginDto;
  } | null;
}

/** Una oportunidad que da SISTRIX (`seo_domain_opportunities`). */
export interface SeoOpportunitySistrixRow {
  keyword: string;
  position: number | null;
  url: string | null;
  gain: number | null;
  competition: number | null;
  traffic: number | null;
  origin: SeoDataOriginDto;
}

/** Una palabra en la que un competidor sale en el top 20 y tú no (ya filtrada). */
export interface SeoOpportunityGapRow {
  keyword: string;
  competitors: { domain: string; position: number; url: string }[];
  origin: SeoDataOriginDto;
}

export interface SeoOpportunityMetricsDto {
  gsc: {
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
    expectedCtr: number | null;
    from: string;
    to: string;
    previous: {
      clicks: number;
      impressions: number;
      position: number | null;
      from: string;
      to: string;
    } | null;
    positionDiff: number | null;
    impressionsPct: number | null;
  } | null;
  sistrix: {
    volume: number | null;
    competition: number | null;
    cpc: number | null;
    position: number | null;
    url: string | null;
    gain: number | null;
    provider: SeoProviderKey;
    fetchedAt: string;
    dataDate: string | null;
  } | null;
  competitors: { domain: string; position: number; url: string }[] | null;
  competitorsOrigin: SeoDataOriginDto | null;
  intent: { value: SeoKeywordIntent; source: SeoIntentSource } | null;
  priority: number | null;
  inCatalog: boolean;
  brand: boolean;
  /** Impresiones reales ÷ volumen de SISTRIX (§18.6; no es una cuota de mercado exacta). */
  impressionShare: number | null;
  /** Lectura de «Demanda real frente a SISTRIX». */
  demandVariant: 'unseen_by_sistrix' | 'above_volume' | 'low_share' | null;
}

export interface SeoOpportunityCandidate extends SeoOpportunityScoreDto {
  /** Clave estable (tipo, dominio y búsqueda): el API la guarda resumida. */
  key: string;
  type: SeoOpportunityType;
  domain: string;
  query: string;
  /** Página que más clics recibe por esa búsqueda (la pone el API). */
  page: string | null;
  targetUrl: string | null;
  sources: SeoOpportunitySource[];
  metrics: SeoOpportunityMetricsDto;
  reason: string;
  action: string;
}

export interface SeoOpportunityDetectInput {
  domain: string;
  brandTerms: string[];
  weights: SeoWeights;
  thresholds: SeoOpportunityThresholds;
  period: {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
    comparable: boolean;
  };
  queries: SeoOpportunityQueryRow[];
  keywords: SeoOpportunityKeywordRow[];
  /** El proyecto ya tiene métricas de SISTRIX (si no, «sin dato» no significa nada). */
  sistrixMetricsAvailable: boolean;
  sistrixOpportunities: SeoOpportunitySistrixRow[];
  keywordGaps: SeoOpportunityGapRow[];
  /**
   * Conversiones de Google de la página que sale por cada búsqueda (clave:
   * la búsqueda normalizada). Opcional (PR 8): el factor «La página convierte».
   */
  pageConversionsByQuery?: Record<string, SeoPageConversionStat>;
}

const pctChange = (now: number, before: number): number | null =>
  before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null;

/** Clave estable de una oportunidad. */
export function seoOpportunityKey(type: SeoOpportunityType, domain: string, query: string): string {
  return `${type}|${domain}|${normalizeSeoKeyword(query)}`;
}

/**
 * Detecta las oportunidades de un dominio. Una búsqueda puede dar varias
 * (p. ej. «cerca del top 3» y «poco clic»: son acciones distintas). Las de
 * marca se excluyen salvo que caigan. Las de SISTRIX que coinciden con una
 * propia se fusionan con ella (marcando los dos orígenes).
 */
export function detectSeoOpportunities(
  input: SeoOpportunityDetectInput,
): SeoOpportunityCandidate[] {
  const t = input.thresholds;
  const days =
    Math.round(
      (Date.parse(`${input.period.to}T00:00:00Z`) - Date.parse(`${input.period.from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  const keywords = new Map(input.keywords.map((k) => [normalizeSeoKeyword(k.keyword), k]));
  const out = new Map<string, SeoOpportunityCandidate>();

  const gscOf = (q: SeoOpportunityQueryRow): SeoOpportunityMetricsDto['gsc'] => {
    const ctr = q.impressions > 0 ? Math.round((q.clicks / q.impressions) * 10000) / 10000 : null;
    const prev = input.period.comparable ? q.previous : null;
    return {
      clicks: q.clicks,
      impressions: q.impressions,
      ctr,
      position: q.position,
      expectedCtr: q.position !== null ? expectedCtr(q.position) : null,
      from: input.period.from,
      to: input.period.to,
      previous: prev
        ? {
            ...prev,
            from: input.period.previousFrom,
            to: input.period.previousTo,
          }
        : null,
      positionDiff:
        prev && prev.position !== null && q.position !== null
          ? Math.round((prev.position - q.position) * 10) / 10
          : null,
      impressionsPct: prev ? pctChange(q.impressions, prev.impressions) : null,
    };
  };

  const build = (
    type: SeoOpportunityType,
    query: string,
    parts: {
      gsc: SeoOpportunityMetricsDto['gsc'];
      sistrix: SeoOpportunityMetricsDto['sistrix'];
      competitors?: SeoOpportunityGapRow | null;
      demandVariant?: SeoOpportunityMetricsDto['demandVariant'];
    },
  ): SeoOpportunityCandidate => {
    const norm = normalizeSeoKeyword(query);
    const kw = keywords.get(norm) ?? null;
    const intent = seoResolveIntent({
      manual: kw?.intent ?? null,
      sistrix: kw?.metrics?.intent ?? null,
      query: norm,
    });
    const sistrix = parts.sistrix;
    const volume = sistrix?.volume ?? null;
    const impressions = parts.gsc?.impressions ?? null;
    const metrics: SeoOpportunityMetricsDto = {
      gsc: parts.gsc,
      sistrix,
      competitors: parts.competitors?.competitors ?? null,
      competitorsOrigin: parts.competitors?.origin ?? null,
      intent,
      priority: kw?.inCatalog ? kw.priority : null,
      inCatalog: !!kw?.inCatalog,
      brand: isBrandQuery(norm, input.brandTerms),
      impressionShare:
        impressions !== null && volume !== null && volume > 0
          ? Math.round((impressions / volume) * 1000) / 1000
          : null,
      demandVariant: parts.demandVariant ?? null,
    };
    const score = scoreSeoOpportunity(
      {
        impressions,
        clicks: parts.gsc?.clicks ?? null,
        volume,
        gain: sistrix?.gain ?? null,
        position: parts.gsc?.position ?? sistrix?.position ?? null,
        ctr: parts.gsc?.ctr ?? null,
        intent: intent?.value ?? null,
        priority: metrics.priority,
        positionDiff: parts.gsc?.positionDiff ?? null,
        impressionsPct: parts.gsc?.impressionsPct ?? null,
        competition: sistrix?.competition ?? null,
        hasGsc: parts.gsc !== null && parts.gsc.impressions > 0,
        hasSistrix: sistrix !== null || !!parts.competitors,
        comparable: parts.gsc?.previous !== null && parts.gsc?.previous !== undefined,
        pageConversions: input.pageConversionsByQuery?.[norm] ?? null,
      },
      input.weights,
    );
    const sources: SeoOpportunitySource[] = [];
    if (parts.gsc) sources.push('gsc');
    if (sistrix || parts.competitors) sources.push('sistrix');
    const candidate: SeoOpportunityCandidate = {
      ...score,
      key: seoOpportunityKey(type, input.domain, norm),
      type,
      domain: input.domain,
      query: norm,
      page: null,
      targetUrl: kw?.targetUrl ?? null,
      sources,
      metrics,
      reason: '',
      action: SEO_OPPORTUNITY_ACTIONS[type],
    };
    candidate.reason = seoOpportunityReason(candidate, days);
    if (type === 'demand_gap' && metrics.demandVariant === 'low_share') {
      candidate.action =
        'Hay mucha demanda y apenas apareces: hace falta una página que responda de verdad a esta búsqueda.';
    }
    return candidate;
  };

  const sistrixOfKeyword = (
    kw: SeoOpportunityKeywordRow | undefined,
  ): SeoOpportunityMetricsDto['sistrix'] =>
    kw?.metrics
      ? {
          volume: kw.metrics.volume,
          competition: kw.metrics.competition,
          cpc: kw.metrics.cpc,
          position: null,
          url: null,
          gain: null,
          provider: kw.metrics.origin.provider,
          fetchedAt: kw.metrics.origin.fetchedAt,
          dataDate: kw.metrics.origin.dataDate,
        }
      : null;

  const add = (c: SeoOpportunityCandidate) => out.set(c.key, c);
  const ownQueries = new Set<string>();

  for (const q of input.queries) {
    const norm = normalizeSeoKeyword(q.query);
    if (!norm) continue;
    ownQueries.add(norm);
    const brand = isBrandQuery(norm, input.brandTerms);
    const kw = keywords.get(norm);
    const gsc = gscOf(q);
    const sistrix = sistrixOfKeyword(kw);
    const pos = q.position;

    // Sube y baja: periodos comparables y un mínimo de impresiones en los dos.
    const prev = gsc?.previous;
    if (
      prev &&
      pos !== null &&
      prev.position !== null &&
      q.impressions >= t.trendMinImpressions &&
      prev.impressions >= t.trendMinImpressions
    ) {
      const diff = gsc!.positionDiff ?? 0;
      const ip = gsc!.impressionsPct ?? 0;
      const rising = diff >= t.trendMinPositions || (diff >= 0 && ip >= t.trendMinImpressionsPct);
      const falling =
        diff <= -t.trendMinPositions || (diff <= 0 && ip <= -t.trendMinImpressionsPct);
      if (falling) add(build('falling', norm, { gsc, sistrix }));
      else if (rising && !brand) add(build('rising', norm, { gsc, sistrix }));
    }
    if (brand) continue;

    if (pos !== null) {
      if (pos >= 3.5 && pos <= 10 && q.impressions >= t.minImpressions) {
        add(build('near_top3', norm, { gsc, sistrix }));
      } else if (pos > 10 && pos <= 20 && q.impressions >= t.minImpressions) {
        add(build('near_page1', norm, { gsc, sistrix }));
      } else if (pos > 20 && pos <= 50 && q.impressions >= t.commercialMinImpressions) {
        const intent = seoResolveIntent({
          manual: kw?.intent ?? null,
          sistrix: kw?.metrics?.intent ?? null,
          query: norm,
        });
        if (isCommercialIntent(intent?.value))
          add(build('commercial_deep', norm, { gsc, sistrix }));
      }
      // Mucho aparecer y poco clic (solo donde el CTR esperado tiene sentido).
      if (pos <= 20 && q.impressions >= t.lowCtrMinImpressions && gsc!.ctr !== null) {
        const expected = expectedCtr(pos);
        if (gsc!.ctr < expected * t.lowCtrRatio) add(build('low_ctr', norm, { gsc, sistrix }));
      }
    }

    // Impresiones reales frente al volumen de SISTRIX (§18.6).
    if (kw?.metrics || (kw?.inCatalog && input.sistrixMetricsAvailable)) {
      const volume = kw.metrics?.volume ?? null;
      let variant: SeoOpportunityMetricsDto['demandVariant'] = null;
      if ((volume === null || volume === 0) && q.impressions >= t.demandGapMinImpressions) {
        variant = 'unseen_by_sistrix';
      } else if (
        volume !== null &&
        volume > 0 &&
        q.impressions >= t.demandGapMinImpressions &&
        q.impressions > volume
      ) {
        variant = 'above_volume';
      } else if (volume !== null && volume >= t.highVolume && q.impressions < volume * t.lowShare) {
        variant = 'low_share';
      }
      if (variant) add(build('demand_gap', norm, { gsc, sistrix, demandVariant: variant }));
    }
  }

  // Volumen alto en tus palabras donde ni apareces (sin impresiones).
  for (const kw of input.keywords) {
    const norm = normalizeSeoKeyword(kw.keyword);
    if (!kw.inCatalog || ownQueries.has(norm) || isBrandQuery(norm, input.brandTerms)) continue;
    const volume = kw.metrics?.volume ?? null;
    if (volume !== null && volume >= t.highVolume) {
      add(
        build('demand_gap', norm, {
          gsc: null,
          sistrix: sistrixOfKeyword(kw),
          demandVariant: 'low_share',
        }),
      );
    }
  }

  // Oportunidades de SISTRIX: con una propia de la misma búsqueda, se fusionan.
  const byQuery = new Map<string, SeoOpportunityCandidate[]>();
  for (const c of out.values()) {
    const list = byQuery.get(c.query) ?? [];
    list.push(c);
    byQuery.set(c.query, list);
  }
  const queryRows = new Map(input.queries.map((q) => [normalizeSeoKeyword(q.query), q]));
  for (const s of input.sistrixOpportunities) {
    const norm = normalizeSeoKeyword(s.keyword);
    if (!norm || isBrandQuery(norm, input.brandTerms)) continue;
    const kw = keywords.get(norm);
    const sistrix: NonNullable<SeoOpportunityMetricsDto['sistrix']> = {
      volume: s.traffic ?? kw?.metrics?.volume ?? null,
      competition: s.competition ?? kw?.metrics?.competition ?? null,
      cpc: kw?.metrics?.cpc ?? null,
      position: s.position,
      url: s.url,
      gain: s.gain,
      provider: s.origin.provider,
      fetchedAt: s.origin.fetchedAt,
      dataDate: s.origin.dataDate,
    };
    const own = byQuery.get(norm);
    if (own && own.length > 0) {
      for (const c of own) {
        const merged = build(c.type, norm, {
          gsc: c.metrics.gsc,
          sistrix,
          competitors: c.metrics.competitors
            ? {
                keyword: norm,
                competitors: c.metrics.competitors,
                origin: c.metrics.competitorsOrigin!,
              }
            : null,
          demandVariant: c.metrics.demandVariant,
        });
        add(merged);
      }
      continue;
    }
    const row = queryRows.get(norm);
    add(build('sistrix', norm, { gsc: row ? gscOf(row) : null, sistrix }));
  }

  // La competencia sale en el top 20 y tú no.
  for (const g of input.keywordGaps) {
    const norm = normalizeSeoKeyword(g.keyword);
    if (!norm || ownQueries.has(norm) || isBrandQuery(norm, input.brandTerms)) continue;
    const ranked = g.competitors.filter((c) => c.position <= t.keywordGapMaxPosition);
    if (ranked.length === 0) continue;
    const kw = keywords.get(norm);
    add(
      build('keyword_gap', norm, {
        gsc: null,
        sistrix: sistrixOfKeyword(kw),
        competitors: { ...g, competitors: [...ranked].sort((a, b) => a.position - b.position) },
      }),
    );
  }

  return [...out.values()].sort((a, b) => b.score - a.score || a.query.localeCompare(b.query));
}

/** Motivo de una oportunidad en lenguaje llano, con sus números. */
export function seoOpportunityReason(c: SeoOpportunityCandidate, days: number): string {
  const g = c.metrics.gsc;
  const s = c.metrics.sistrix;
  const pos = g?.position ?? s?.position ?? null;
  const posText = pos !== null ? `la posición ${fmtPos(pos)}` : 'ninguna posición';
  const impr = g ? `${seoFmtInt(g.impressions)} impresiones en ${days} días` : '';
  switch (c.type) {
    case 'near_top3':
      return `Sale en ${posText} con ${impr}: está cerca del top 3, donde se llevan la mayoría de los clics.`;
    case 'near_page1':
      return `Sale en ${posText}, en la segunda página de Google, con ${impr}: un empujón la llevaría a la primera.`;
    case 'commercial_deep':
      return `Es una búsqueda de alguien que quiere ${c.metrics.intent ? INTENT_WORDS[c.metrics.intent.value] : 'contratar'} y sales en ${posText}: casi nadie llega tan abajo.`;
    case 'low_ctr':
      return `Aparece ${impr} pero solo recibe ${seoFmtInt(g?.clicks ?? 0)} clics (CTR ${fmtPct(g?.ctr ?? 0)}); en ${posText} lo normal sería un ${fmtPct(g?.expectedCtr ?? 0)}.`;
    case 'rising':
    case 'falling': {
      const prev = g?.previous;
      const diff = Math.abs(g?.positionDiff ?? 0);
      const verb = c.type === 'rising' ? 'subido' : 'bajado';
      const moved =
        diff > 0 && prev?.position != null && g?.position != null
          ? `Ha ${verb} ${fmtPos(diff)} puestos (de ${fmtPos(prev.position)} a ${fmtPos(g.position)})`
          : `Mantiene la posición`;
      const imp = prev
        ? ` y sus impresiones han pasado de ${seoFmtInt(prev.impressions)} a ${seoFmtInt(g?.impressions ?? 0)}`
        : '';
      return `${moved}${imp} frente al periodo anterior${c.metrics.brand ? ' (es una búsqueda de tu marca)' : ''}.`;
    }
    case 'demand_gap':
      switch (c.metrics.demandVariant) {
        case 'unseen_by_sistrix':
          return `Tiene ${impr} reales, pero SISTRIX no le da volumen: es demanda (seguramente local) que su muestra no ve.`;
        case 'above_volume':
          return `Tiene ${impr}, más que las ${seoFmtInt(s?.volume ?? 0)} búsquedas al mes que estima SISTRIX: su estimación se queda corta aquí.`;
        default:
          return `SISTRIX estima ${seoFmtInt(s?.volume ?? 0)} búsquedas al mes y ${g ? `solo tienes ${impr}` : 'tu web no aparece'}: no sales en la primera página.`;
      }
    case 'sistrix':
      return `SISTRIX la detecta como oportunidad: sales en ${posText}${s?.gain != null ? ` y estima ${seoFmtInt(s.gain)} visitas más si subes` : ''}.`;
    case 'keyword_gap': {
      const best = c.metrics.competitors?.[0];
      const more = (c.metrics.competitors?.length ?? 0) - 1;
      return best
        ? `${best.domain} sale en la posición ${best.position}${more > 0 ? ` (y ${more} competidor${more === 1 ? '' : 'es'} más)` : ''} y tu web no aparece, ni en Search Console ni en SISTRIX.`
        : 'Tus competidores salen y tu web no aparece.';
    }
  }
}

// -------------------------------------------------------------------- API

export interface SeoScoredOpportunityDto {
  id: string;
  projectId: string;
  domain: string;
  type: SeoOpportunityType;
  query: string;
  page: string | null;
  targetUrl: string | null;
  score: number;
  confidence: number;
  factors: SeoOpportunityFactorDto[];
  metrics: SeoOpportunityMetricsDto;
  sources: SeoOpportunitySource[];
  reason: string;
  action: string;
  status: SeoOpportunityStatus;
  dismissReason: string | null;
  notes: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  /** Sigue saliendo en el último cálculo (si no, ya no se cumple la regla). */
  active: boolean;
  /** Estaba descartada y ha vuelto (subió lo bastante). */
  returnedAt: string | null;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export const SEO_OPPORTUNITY_SORTS = ['score', 'detected', 'updated'] as const;
export type SeoOpportunitySort = (typeof SEO_OPPORTUNITY_SORTS)[number];
export const SEO_OPPORTUNITY_PAGE_SIZE = 50;
export const SEO_OPPORTUNITY_CSV_MAX = 5000;

export interface SeoOpportunityPageDto {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** Último cálculo del proyecto. */
  calculatedAt: string | null;
  items: SeoScoredOpportunityDto[];
}

export interface SeoOpportunitySummaryDto {
  calculatedAt: string | null;
  /** Pendientes (nuevas, vistas y en curso) por tipo. */
  byType: Record<SeoOpportunityType, number>;
  /** Todas las que siguen detectándose, por estado. */
  byStatus: Record<SeoOpportunityStatus, number>;
  /** Las 5 mejores pendientes. */
  top: SeoScoredOpportunityDto[];
  /** Cuántas han vuelto tras descartarlas. */
  returned: number;
}

export interface SeoOpportunityDetailDto extends SeoScoredOpportunityDto {
  /** Evolución diaria de esa búsqueda en Search Console (90 días). */
  daily: {
    date: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
  }[];
  /** Sus páginas en el periodo. */
  pages: { page: string; clicks: number; impressions: number; position: number | null }[];
  /** Resultados de Google de esa palabra (si está en tus palabras y se han pedido). */
  serp: {
    origin: SeoDataOriginDto;
    results: { position: number; domain: string; url: string; own: boolean; competitor: boolean }[];
  } | null;
}

export interface SeoOpportunityRecalcDto {
  calculatedAt: string;
  detected: number;
  created: number;
  returned: number;
  /** Ya no se cumplen (salen de la lista de pendientes). */
  gone: number;
}

export const UpdateSeoOpportunitySchema = z
  .object({
    status: SeoOpportunityStatusEnum,
    dismissReason: z.string().trim().min(3).max(500).nullable(),
    notes: z.string().trim().max(2000).nullable(),
    /** Usuario del negocio (tenant) o super admin (plataforma); null = sin asignar. */
    assignedToId: z.string().uuid().nullable(),
  })
  .partial()
  .refine((v) => v.status !== 'dismissed' || !!v.dismissReason, {
    message: 'Para descartarla, di por qué.',
    path: ['dismissReason'],
  });
export type UpdateSeoOpportunityInput = z.infer<typeof UpdateSeoOpportunitySchema>;

/** Persona a la que se puede asignar una oportunidad. */
export interface SeoOpportunityAssigneeDto {
  id: string;
  name: string;
}
