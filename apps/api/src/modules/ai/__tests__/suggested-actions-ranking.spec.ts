import { applySuggestedActionsRanking } from '../suggested-actions-ranking';

import type { SuggestedActionDto } from '@storageos/shared';

const base: SuggestedActionDto[] = [
  {
    id: 'renewal-1',
    category: 'renewal',
    priority: 'medium',
    title: 'Ana vence pronto',
    detail: 'Contrato C-1 vence el 1/10',
    href: '/contracts/1',
    cta: 'Ver contrato',
  },
  {
    id: 'collections',
    category: 'collections',
    priority: 'high',
    title: 'Reclama 3 facturas vencidas',
    detail: '450.00 € pendientes',
    href: '/invoices?status=overdue',
    cta: 'Ver facturas',
  },
];

describe('applySuggestedActionsRanking', () => {
  it('reordena y reescribe conservando enlace, categoría y prioridad', () => {
    const raw =
      '```json\n{"actions":[{"id":"collections","title":"Cobra hoy 450 € vencidos","detail":"3 facturas sin pagar"},{"id":"renewal-1","title":"Renueva a Ana","detail":"Vence el 1/10"}]}\n```';
    const out = applySuggestedActionsRanking(base, raw)!;
    expect(out.map((a) => a.id)).toEqual(['collections', 'renewal-1']);
    expect(out[0]).toMatchObject({
      title: 'Cobra hoy 450 € vencidos',
      href: '/invoices?status=overdue',
      priority: 'high',
    });
  });

  it('descarta ids inventados y conserva al final los omitidos', () => {
    const raw = '{"actions":[{"id":"fake","title":"x"},{"id":"renewal-1","title":"Renueva"}]}';
    const out = applySuggestedActionsRanking(base, raw)!;
    expect(out.map((a) => a.id)).toEqual(['renewal-1', 'collections']);
    expect(out[0]!.detail).toBe('Contrato C-1 vence el 1/10');
  });

  it('respuesta no JSON o sin ids válidos → null (el llamador usa la heurística)', () => {
    expect(applySuggestedActionsRanking(base, 'Lo siento, no puedo')).toBeNull();
    expect(applySuggestedActionsRanking(base, '{"actions":[{"id":"nope"}]}')).toBeNull();
  });

  it('recorta textos demasiado largos', () => {
    const long = 'a'.repeat(300);
    const out = applySuggestedActionsRanking(
      base,
      `{"actions":[{"id":"collections","title":"${long}","detail":"${long}"}]}`,
    )!;
    expect(out[0]!.title.length).toBeLessThanOrEqual(80);
    expect(out[0]!.detail.length).toBeLessThanOrEqual(160);
  });
});
