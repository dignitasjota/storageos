import { parseAssistantReply, redactSigningLinks, redactTaxIds } from '../web-chat-markers';
import { MarkerStreamFilter } from '../web-chat.service';

describe('parseAssistantReply', () => {
  it('separa el texto de las marcas bien escritas', () => {
    const r = parseAssistantReply(
      'Perfecto, te lo preparo.\n[[RESERVA {"tipo":"L1-T2","fecha":"2026-12-01"}]]',
    );
    expect(r.text).toBe('Perfecto, te lo preparo.');
    expect(r.booking).toBe('{"tipo":"L1-T2","fecha":"2026-12-01"}');
    expect(r.brokenMarker).toBe(false);
  });

  it('admite mayúsculas, espacios y dos puntos que el modelo añade', () => {
    const r = parseAssistantReply(
      'Hecho. [[ reserva: {"tipo":"L1-T1"} ]] [[ HUMANO ]] [[SIN RESPUESTA]] [[Contacto {"email":"a@b.es"}]]',
    );
    expect(r.booking).toBe('{"tipo":"L1-T1"}');
    expect(r.contact).toBe('{"email":"a@b.es"}');
    expect(r.handoff).toBe(true);
    expect(r.unanswered).toBe(true);
    expect(r.text).toBe('Hecho.');
  });

  it('una marca cortada (límite de tokens) no se enseña y avisa de la reserva', () => {
    const r = parseAssistantReply('Te reservo el trastero. [[RESERVA {"tipo":"L1-T2","nomb');
    expect(r.text).toBe('Te reservo el trastero.');
    expect(r.booking).toBeNull();
    expect(r.brokenBooking).toBe(true);
    expect(r.brokenMarker).toBe(true);
  });

  it('una marca desconocida o mal escrita se quita', () => {
    const r = parseAssistantReply('Hola. [[RESERVAR datos]] ¿Algo más? [[FOO]]');
    expect(r.text).toBe('Hola. ¿Algo más?');
    expect(r.brokenMarker).toBe(true);
    expect(r.brokenBooking).toBe(true);
  });

  it('solo una marca: texto vacío pero sin error', () => {
    const r = parseAssistantReply('[[HUMANO]]');
    expect(r.text).toBe('');
    expect(r.handoff).toBe(true);
    expect(r.brokenMarker).toBe(false);
  });

  it('quita el formato Markdown que el widget no pinta', () => {
    const r = parseAssistantReply(
      '## Precios\n**Trastero mediano**: 60 €. [Reserva](https://x.es/reservar)',
    );
    expect(r.text).toBe('Precios\nTrastero mediano: 60 €. Reserva: https://x.es/reservar');
  });
});

describe('redacciones del historial', () => {
  it('enlace de firma fuera del texto guardado', () => {
    expect(
      redactSigningLinks('Firma aquí: https://garcia.es/sign/abc.DEF-123\nGracias', '[enlace]'),
    ).toBe('Firma aquí: [enlace]\nGracias');
  });
  it('DNI y NIE tapados', () => {
    expect(redactTaxIds('Mi DNI es 12345678Z y el NIE X1234567L')).toBe(
      'Mi DNI es ••••••78Z y el NIE ••••••67L',
    );
    expect(redactTaxIds('Llamadme al 600333444')).toBe('Llamadme al 600333444');
  });
});

describe('MarkerStreamFilter', () => {
  it('deja pasar el texto y se calla desde la primera marca', () => {
    const out: string[] = [];
    const f = new MarkerStreamFilter((d) => out.push(d));
    f.push('Hola, ');
    f.push('te lo reservo [');
    f.push('[RESERVA {"tipo":"L1"}]] y más');
    expect(out.join('')).toBe('Hola, te lo reservo ');
  });
});
