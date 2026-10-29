import { describe, expect, it } from 'vitest';

import { DEFAULT_STORAGE_CLAUSES, renderContractClauses } from './index';

describe('condiciones generales del trastero', () => {
  it('recogen lo prohibido, el impago con plazo y la revisión por IPC', () => {
    const text = renderContractClauses(DEFAULT_STORAGE_CLAUSES, {
      contractNumber: 'C-1',
      customerName: 'Ana Pérez',
      unitCode: 'A-01',
      facilityName: 'Centro',
      priceMonthly: '60.00 €',
      depositAmount: '60.00 €',
      startDate: '2026-11-01',
      cancellationNoticeDays: '15',
      tenantName: 'Trasteros García SL',
    });
    expect(text).toContain('- Armas, municiones y explosivos.');
    expect(text).toContain('no está embargado');
    expect(text).toContain('un solo candado de su propiedad');
    expect(text).toContain('Índice de Precios al Consumo (IPC)');
    expect(text).toContain('gastos de gestión');
    // La disposición de los bienes exige requerimiento previo y deja el sobrante al inquilino.
    expect(text).toContain('pese al requerimiento, se considerarán abandonados');
    expect(text).toContain('el sobrante quedará a disposición del inquilino');
    expect(text).not.toContain('{{');
  });
});
