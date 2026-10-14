import { extensionForMime, parseWabaMessage } from '../whatsapp-message-parse';

describe('parseWabaMessage', () => {
  it('texto', () => {
    expect(parseWabaMessage({ type: 'text', text: { body: ' Hola ' } })).toEqual({
      body: 'Hola',
      media: null,
    });
    expect(parseWabaMessage({ type: 'text', text: { body: '  ' } })).toBeNull();
  });

  it('foto con pie y documento con nombre', () => {
    expect(
      parseWabaMessage({
        type: 'image',
        image: { id: 'M1', mime_type: 'image/jpeg', caption: 'Mi trastero' },
      }),
    ).toEqual({
      body: '[Foto] Mi trastero',
      media: { type: 'image', id: 'M1', mime: 'image/jpeg', filename: null },
    });
    expect(
      parseWabaMessage({
        type: 'document',
        document: { id: 'M2', mime_type: 'application/pdf', filename: 'dni.pdf' },
      })?.body,
    ).toBe('[Documento: dni.pdf]');
    expect(
      parseWabaMessage({ type: 'audio', audio: { id: 'M3', mime_type: 'audio/ogg', voice: true } })
        ?.body,
    ).toBe('[Nota de voz]');
    expect(parseWabaMessage({ type: 'image', image: {} })).toBeNull();
  });

  it('ubicación, botones y tipos ignorados', () => {
    expect(
      parseWabaMessage({
        type: 'location',
        location: { latitude: 39.47, longitude: -0.38, name: 'Casa' },
      })?.body,
    ).toBe('📍 Casa · https://maps.google.com/?q=39.47,-0.38');
    expect(parseWabaMessage({ type: 'button', button: { text: 'Sí, reservar' } })?.body).toBe(
      'Sí, reservar',
    );
    expect(
      parseWabaMessage({ type: 'interactive', interactive: { list_reply: { title: 'Pequeño' } } })
        ?.body,
    ).toBe('Pequeño');
    expect(parseWabaMessage({ type: 'reaction' })).toBeNull();
  });
});

describe('extensionForMime', () => {
  it('usa la extensión del nombre o la del tipo', () => {
    expect(extensionForMime('application/pdf', 'contrato.PDF')).toBe('pdf');
    expect(extensionForMime('audio/ogg; codecs=opus', null)).toBe('ogg');
    expect(extensionForMime(null, null)).toBe('bin');
  });
});
