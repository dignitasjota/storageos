import { describe, expect, it } from 'vitest';

import { fillAdminMessageVariables, fillLifecycleTemplate, npsScore } from './comms';

describe('comunicación del panel admin', () => {
  it('sustituye las variables del mensaje', () => {
    expect(
      fillAdminMessageVariables('Hola {nombre}, {empresa}', {
        empresa: 'Trasteros Ana',
        nombre: 'Ana López',
      }),
    ).toBe('Hola Ana, Trasteros Ana');
    expect(fillAdminMessageVariables('Hola {nombre}', { empresa: 'X' })).toBe('Hola ');
  });

  it('rellena un correo automático y quita los huecos', () => {
    expect(
      fillLifecycleTemplate('Hola {empresa}\n\n{limites}\n\nFin {otra}', {
        empresa: 'A',
        limites: '',
      }),
    ).toBe('Hola A\n\nFin {otra}');
  });

  it('calcula el NPS', () => {
    expect(npsScore([])).toBeNull();
    expect(npsScore([10, 9, 8, 3])).toBe(25);
  });
});
