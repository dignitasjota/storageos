import { aiCostOfRows, aiCostUsd, aiModelPrice, isKnownAiModel } from '../ai-pricing';

const FALLBACK = { inputPerMTokUsd: 3, outputPerMTokUsd: 15 };

describe('ai-pricing', () => {
  it('precio por modelo, también con fecha en el identificador', () => {
    expect(aiModelPrice('claude-haiku-4-5-20251001', FALLBACK)).toEqual({
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 5,
    });
    expect(aiModelPrice('claude-opus-5-5', FALLBACK).inputPerMTokUsd).toBe(4);
    expect(aiModelPrice('claude-opus-5', FALLBACK).inputPerMTokUsd).toBe(5);
    expect(aiModelPrice('claude-opus-4-1', FALLBACK).inputPerMTokUsd).toBe(15);
    expect(aiModelPrice('claude-sonnet-5-5', FALLBACK).inputPerMTokUsd).toBe(2);
    expect(aiModelPrice('claude-sonnet-4-6', FALLBACK).inputPerMTokUsd).toBe(3);
    expect(aiModelPrice('claude-haiku-5-5', FALLBACK).outputPerMTokUsd).toBe(0.5);
    expect(aiModelPrice('claude-fable-5-2', FALLBACK).inputPerMTokUsd).toBe(8);
    expect(aiModelPrice('claude-fable-5-1', FALLBACK).inputPerMTokUsd).toBe(10);
  });

  it('un modelo desconocido usa el precio de respaldo', () => {
    expect(aiModelPrice('gpt-x', FALLBACK)).toBe(FALLBACK);
    expect(aiModelPrice(null, FALLBACK)).toBe(FALLBACK);
    expect(isKnownAiModel('gpt-x')).toBe(false);
    expect(isKnownAiModel('claude-sonnet-4-6')).toBe(true);
  });

  it('coste de varias filas', () => {
    expect(aiCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000, FALLBACK)).toBeCloseTo(6);
    expect(
      aiCostOfRows(
        [
          { model: 'claude-sonnet-4-6', inputTokens: 1_000_000, outputTokens: 0 },
          { model: 'desconocido', inputTokens: 0, outputTokens: 1_000_000 },
        ],
        FALLBACK,
      ),
    ).toBeCloseTo(18);
  });
});
