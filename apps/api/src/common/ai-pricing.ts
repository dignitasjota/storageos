/**
 * Precio por millón de tokens (USD, entrada / salida) de cada modelo de IA
 * para estimar el coste en Uso, Finanzas, Asistente IA y los avisos.
 *
 * Tarifas de la API de Anthropic (primera parte, sin caché ni lotes), por
 * familia y versión. El nombre del modelo se compara por prefijo, así que
 * casan también los identificadores con fecha (`claude-haiku-4-5-20251001`).
 * Para un modelo que no esté aquí (otro proveedor, uno nuevo) se usan los
 * precios de `AI_COST_INPUT_PER_MTOK_USD` / `AI_COST_OUTPUT_PER_MTOK_USD`.
 *
 *  | Modelo                                  | Entrada | Salida |
 *  |-----------------------------------------|---------|--------|
 *  | Fable 5.2 · Mythos 5.2                  |   8     |   40   |
 *  | Fable 5 / 5.1 · Mythos 5 / 5.1          |  10     |   50   |
 *  | Opus 5.5                                |   4     |   20   |
 *  | Opus 5 · 4.8 · 4.7 · 4.6 · 4.5          |   5     |   25   |
 *  | Opus 4.1 · 4 · 3                        |  15     |   75   |
 *  | Sonnet 5.5 · 5                          |   2     |   10   |
 *  | Sonnet 4.6 · 4.5 · 4 · 3.7 · 3.5        |   3     |   15   |
 *  | Haiku 5.5 (hasta 100K de entrada)       |   0,10  |  0,50  |
 *  | Haiku 4.5                               |   1     |    5   |
 *  | Haiku 3.5                               |   0,80  |    4   |
 *  | Haiku 3                                 |   0,25  |  1,25  |
 */

export interface AiModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

const PRICES: { prefixes: string[]; input: number; output: number }[] = [
  { prefixes: ['claude-fable-5-2', 'claude-mythos-5-2'], input: 8, output: 40 },
  {
    prefixes: ['claude-fable-5', 'claude-mythos-5'],
    input: 10,
    output: 50,
  },
  { prefixes: ['claude-opus-5-5'], input: 4, output: 20 },
  {
    prefixes: [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
    ],
    input: 5,
    output: 25,
  },
  {
    prefixes: ['claude-opus-4-1', 'claude-opus-4', 'claude-3-opus'],
    input: 15,
    output: 75,
  },
  { prefixes: ['claude-sonnet-5'], input: 2, output: 10 },
  {
    prefixes: ['claude-sonnet-4', 'claude-3-7-sonnet', 'claude-3-5-sonnet'],
    input: 3,
    output: 15,
  },
  { prefixes: ['claude-haiku-5'], input: 0.1, output: 0.5 },
  { prefixes: ['claude-haiku-4'], input: 1, output: 5 },
  { prefixes: ['claude-3-5-haiku'], input: 0.8, output: 4 },
  { prefixes: ['claude-3-haiku'], input: 0.25, output: 1.25 },
];

/** Precio del modelo (o el de respaldo si no se conoce). */
export function aiModelPrice(
  model: string | null | undefined,
  fallback: AiModelPrice,
): AiModelPrice {
  const id = (model ?? '').trim().toLowerCase();
  if (id) {
    for (const p of PRICES) {
      if (p.prefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}-`))) {
        return { inputPerMTokUsd: p.input, outputPerMTokUsd: p.output };
      }
    }
  }
  return fallback;
}

/** ¿Conocemos el precio de este modelo? */
export function isKnownAiModel(model: string | null | undefined): boolean {
  const none = { inputPerMTokUsd: -1, outputPerMTokUsd: -1 };
  return aiModelPrice(model, none) !== none;
}

/** Coste estimado en USD de unos tokens con el precio de su modelo. */
export function aiCostUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  fallback: AiModelPrice,
): number {
  const p = aiModelPrice(model, fallback);
  return (inputTokens * p.inputPerMTokUsd + outputTokens * p.outputPerMTokUsd) / 1_000_000;
}

/** Suma del coste de filas agrupadas por modelo. */
export function aiCostOfRows(
  rows: { model: string | null; inputTokens: number; outputTokens: number }[],
  fallback: AiModelPrice,
): number {
  return rows.reduce(
    (sum, r) => sum + aiCostUsd(r.model, r.inputTokens, r.outputTokens, fallback),
    0,
  );
}
