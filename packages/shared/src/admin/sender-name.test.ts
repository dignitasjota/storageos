import { describe, expect, it } from 'vitest';

import { renderSenderName } from './schemas';

describe('renderSenderName', () => {
  it('sustituye {tipo} (sin distinguir mayúsculas)', () => {
    expect(renderSenderName('TrasterOS · {tipo}', 'Factura')).toBe('TrasterOS · Factura');
    expect(renderSenderName('{TIPO} de TrasterOS', 'Avisos')).toBe('Avisos de TrasterOS');
  });

  it('con el texto vacío quita la variable y los separadores sueltos', () => {
    expect(renderSenderName('TrasterOS · {tipo}', '')).toBe('TrasterOS');
    expect(renderSenderName('TrasterOS - {tipo}', '  ')).toBe('TrasterOS');
    expect(renderSenderName('{tipo} | TrasterOS', '')).toBe('TrasterOS');
    expect(renderSenderName('TrasterOS · {tipo} · Soporte', '')).toBe('TrasterOS · Soporte');
  });

  it('sin la variable deja el nombre tal cual', () => {
    expect(renderSenderName('Self-Storage García', 'Factura')).toBe('Self-Storage García');
  });
});
