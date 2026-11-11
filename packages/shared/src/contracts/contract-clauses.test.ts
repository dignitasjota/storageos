import { describe, expect, it } from 'vitest';

import {
  CONTRACT_TEMPLATE_VARIABLES,
  DEFAULT_STORAGE_CLAUSES,
  earliestMoveOutDate,
  effectiveMoveOutDate,
  monthEndOf,
  monthEndsFrom,
  moveOutRuleText,
  renderContractClauses,
} from './index';

function render(endOfMonth = true): string {
  return renderContractClauses(DEFAULT_STORAGE_CLAUSES, {
    contractNumber: 'C-1',
    customerName: 'Ana Pérez',
    unitCode: 'A-01',
    facilityName: 'Centro',
    priceMonthly: '60,00 €',
    depositAmount: '60,00 €',
    startDate: '01/11/2026',
    cancellationNoticeDays: '15',
    tenantName: 'Trasteros García SL',
    moveOutRule: moveOutRuleText(endOfMonth),
    depositReturnDays: '15',
  });
}

describe('condiciones generales del trastero', () => {
  it('usan solo variables conocidas y no dejan ninguna sin sustituir', () => {
    const known = new Set<string>(CONTRACT_TEMPLATE_VARIABLES.map((v) => v.key));
    for (const [, key] of DEFAULT_STORAGE_CLAUSES.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)) {
      expect(known.has(key!)).toBe(true);
    }
    expect(render()).not.toContain('{{');
  });

  it('recogen lo prohibido sin categorías abiertas, la carga máxima y los pasillos libres', () => {
    const text = render();
    expect(text).toContain('- Armas, municiones y explosivos.');
    expect(text).toContain('- Baterías de litio dañadas, hinchadas o manipuladas.');
    expect(text).toContain('Cargar baterías ni enchufar');
    expect(text).toContain('carga máxima indicada en el trastero o en el módulo');
    expect(text).toContain('salidas de emergencia');
    expect(text).not.toContain('razonablemente no deba guardarse');
    expect(text).toContain('no está embargado');
    expect(text).toContain('un solo candado de su propiedad');
  });

  it('la baja a final de mes, el abono de lo pagado por adelantado y la fianza con plazo', () => {
    const text = render();
    expect(text).toContain(
      'al menos 15 días de antelación. La baja surte efecto el último día del mes',
    );
    expect(text).toContain('se le devuelven los meses enteros que no llegue a usar');
    expect(text).toContain('sin el descuento ni los meses gratis');
    expect(text).toContain(
      'en un plazo máximo de 15 días desde que el inquilino entrega el trastero',
    );
    expect(render(false)).toContain('La baja surte efecto el día que indique el inquilino');
  });

  it('el impago va por pasos y nunca da los bienes por abandonados', () => {
    const text = render();
    expect(text).toContain('podrá pedir cita para retirar sus pertenencias');
    expect(text).toContain('por un medio que deje constancia');
    expect(text).toContain('en un plazo no inferior a 15 días');
    expect(text).toContain(
      'solo venderá, destruirá o dispondrá de otro modo de los bienes por los cauces que permita la ley',
    );
    expect(text).not.toContain('abandonados');
  });

  it('dicen que los bienes no están asegurados y explican la videovigilancia', () => {
    const text = render();
    expect(text).toContain('El arrendador no asegura los bienes que guarda el inquilino');
    expect(text).toContain('no recibe en depósito ni custodia');
    expect(text).toContain('Las imágenes se conservan como máximo un mes');
    expect(text).toContain('Índice de Precios al Consumo (IPC)');
  });

  it('explican el desistimiento de los contratos a distancia', () => {
    const text = render();
    expect(text).toContain('19. Desistimiento.');
    expect(text).toContain('en los 14 días naturales siguientes a la firma');
    expect(text).toContain('se le descuenta la parte proporcional de los días');
  });
});

describe('fecha de la baja', () => {
  it('a final de mes: el último día del mes en que se cumple el preaviso', () => {
    expect(earliestMoveOutDate({ today: '2026-11-10', noticeDays: 15, endOfMonth: true })).toBe(
      '2026-11-30',
    );
    // El preaviso se cumple ya en diciembre: termina el 31 de diciembre.
    expect(earliestMoveOutDate({ today: '2026-11-20', noticeDays: 15, endOfMonth: true })).toBe(
      '2026-12-31',
    );
    // Justo el último día: ese mismo.
    expect(earliestMoveOutDate({ today: '2026-11-15', noticeDays: 15, endOfMonth: true })).toBe(
      '2026-11-30',
    );
    expect(earliestMoveOutDate({ today: '2027-02-01', noticeDays: 15, endOfMonth: true })).toBe(
      '2027-02-28',
    );
  });

  it('el día que elija: hoy más el preaviso', () => {
    expect(earliestMoveOutDate({ today: '2026-11-10', noticeDays: 15, endOfMonth: false })).toBe(
      '2026-11-25',
    );
  });

  it('la fecha pedida se lleva al final de su mes solo si el negocio lo tiene así', () => {
    expect(effectiveMoveOutDate('2026-12-03', true)).toBe('2026-12-31');
    expect(effectiveMoveOutDate('2026-12-03', false)).toBe('2026-12-03');
    expect(monthEndOf('2028-02-10')).toBe('2028-02-29');
  });

  it('los finales de mes para elegir empiezan por el de la fecha dada', () => {
    expect(monthEndsFrom('2026-11-30', 3)).toEqual(['2026-11-30', '2026-12-31', '2027-01-31']);
  });
});
