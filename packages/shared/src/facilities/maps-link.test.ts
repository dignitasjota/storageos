import { describe, expect, it } from 'vitest';

import { coordinatesFromMapsUrl } from './maps-link';

describe('coordinatesFromMapsUrl', () => {
  it('saca las coordenadas de los enlaces largos', () => {
    expect(
      coordinatesFromMapsUrl(
        'https://www.google.com/maps/place/Puerta+del+Sol/@40.4169,-3.7035,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d40.41689!4d-3.70346',
      ),
    ).toEqual({ latitude: 40.41689, longitude: -3.70346 });
    expect(coordinatesFromMapsUrl('https://www.google.com/maps/@39.4699,-0.3763,15z')).toEqual({
      latitude: 39.4699,
      longitude: -0.3763,
    });
    expect(coordinatesFromMapsUrl('https://maps.google.com/?q=41.38,2.17')).toEqual({
      latitude: 41.38,
      longitude: 2.17,
    });
    expect(
      coordinatesFromMapsUrl('https://www.google.com/maps/search/?api=1&query=41.38%2C2.17'),
    ).toEqual({ latitude: 41.38, longitude: 2.17 });
  });

  it('un enlace corto o sin coordenadas no da nada', () => {
    expect(coordinatesFromMapsUrl('https://maps.app.goo.gl/AbCdEf123')).toBeNull();
    expect(coordinatesFromMapsUrl('https://www.google.com/maps/place/Madrid')).toBeNull();
    expect(coordinatesFromMapsUrl('https://www.google.com/maps/@140.1,-3.7,15z')).toBeNull();
  });
});
