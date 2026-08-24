import { describe, expect, it } from 'vitest';

import { mapEmbedUrl, toEmbedVideoUrl } from './embeds';

describe('mapEmbedUrl', () => {
  it('prioriza coordenadas si están presentes', () => {
    const url = mapEmbedUrl({
      address: 'Calle Falsa 123',
      city: 'Madrid',
      postalCode: '28001',
      latitude: 40.4168,
      longitude: -3.7038,
    });
    expect(url).toBe('https://www.google.com/maps?q=40.4168,-3.7038&z=15&output=embed');
  });

  it('sin coordenadas, usa la dirección de texto', () => {
    const url = mapEmbedUrl({
      address: 'Calle Falsa 123',
      city: 'Madrid',
      postalCode: '28001',
      latitude: null,
      longitude: null,
    });
    expect(url).toBe(
      'https://www.google.com/maps?q=' +
        encodeURIComponent('Calle Falsa 123, 28001, Madrid') +
        '&output=embed',
    );
  });

  it('sin dirección ni coordenadas -> null', () => {
    expect(
      mapEmbedUrl({ address: null, city: null, postalCode: null, latitude: null, longitude: null }),
    ).toBeNull();
  });
});

describe('toEmbedVideoUrl', () => {
  it('YouTube watch?v= -> embed', () => {
    expect(toEmbedVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  it('youtu.be corto -> embed', () => {
    expect(toEmbedVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  it('YouTube shorts -> embed', () => {
    expect(toEmbedVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  it('YouTube ya en formato embed -> se conserva', () => {
    expect(toEmbedVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  it('Vimeo -> player embed', () => {
    expect(toEmbedVideoUrl('https://vimeo.com/76979871')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
  });

  it('Vimeo ya en formato player -> se conserva', () => {
    expect(toEmbedVideoUrl('https://player.vimeo.com/video/76979871')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
  });

  it('proveedor no reconocido -> null', () => {
    expect(toEmbedVideoUrl('https://example.com/video.mp4')).toBeNull();
  });

  it('URL inválida -> null', () => {
    expect(toEmbedVideoUrl('no es una url')).toBeNull();
  });

  it('esquema no http(s) -> null', () => {
    expect(toEmbedVideoUrl('javascript:alert(1)')).toBeNull();
  });
});
