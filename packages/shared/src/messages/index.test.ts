import { describe, expect, it } from 'vitest';

import { stripQuotedReply } from './index';

describe('stripQuotedReply', () => {
  it('quita lo citado por Gmail en español', () => {
    const text =
      'Sí, el martes me va bien.\n\nEl lun, 3 nov 2026 a las 10:12, Trasteros <a@b.es> escribió:\n> Hola\n> ¿Vienes?';
    expect(stripQuotedReply(text)).toBe('Sí, el martes me va bien.');
  });

  it('entiende la cabecera partida en dos líneas', () => {
    const text = 'Vale\n\nOn Mon, 3 Nov 2026 at 10:12, Trasteros\n<a@b.es> wrote:\n> Hi';
    expect(stripQuotedReply(text)).toBe('Vale');
  });

  it('corta en la cabecera de Outlook', () => {
    const text = 'Gracias\r\n\r\nDe: Trasteros <a@b.es>\r\nEnviado: lunes\r\nPara: yo';
    expect(stripQuotedReply(text)).toBe('Gracias');
  });

  it('si todo es cita, conserva el texto', () => {
    expect(stripQuotedReply('> solo cita')).toBe('> solo cita');
  });

  it('no toca un mensaje sin citas', () => {
    expect(stripQuotedReply('Una línea\nOtra línea')).toBe('Una línea\nOtra línea');
  });
});
