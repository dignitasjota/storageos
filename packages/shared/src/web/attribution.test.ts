import { describe, expect, it } from 'vitest';

import { detectTrafficSource, sourceFromReferrer, trafficSourceToUtm } from './attribution';

const own = ['trasteros-garcia.com', 'trasteros.pro'];
const detect = (search: string, referrer = '') =>
  detectTrafficSource({ search, referrer, ownHosts: own });

describe('detectTrafficSource', () => {
  it('usa las variables utm del enlace', () => {
    expect(detect('?utm_source=instagram&utm_medium=social&utm_campaign=verano')).toEqual({
      source: 'instagram',
      medium: 'social',
      campaign: 'verano',
    });
  });

  it('las utm mandan sobre el referer', () => {
    expect(detect('?utm_source=flyer', 'https://www.google.es/')).toEqual({ source: 'flyer' });
  });

  it('reconoce los clics en anuncios', () => {
    expect(detect('?gclid=abc')).toEqual({ source: 'google', medium: 'cpc' });
    expect(detect('?gbraid=abc&utm_campaign=trasteros')).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'trasteros',
    });
    expect(detect('?msclkid=x')).toEqual({ source: 'bing', medium: 'cpc' });
  });

  it('fbclid distingue Instagram de Facebook por el referer', () => {
    expect(detect('?fbclid=1', 'https://l.instagram.com/')).toEqual({
      source: 'instagram',
      medium: 'social',
    });
    expect(detect('?fbclid=1', 'https://lm.facebook.com/')).toEqual({
      source: 'facebook',
      medium: 'social',
    });
  });

  it('sin variables, deduce el origen del referer', () => {
    expect(detect('', 'https://www.google.com/search?q=trasteros')).toEqual({
      source: 'google',
      medium: 'organic',
    });
    expect(detect('', 'https://www.idealista.com/inmueble/1')).toEqual({
      source: 'idealista',
      medium: 'referral',
    });
    expect(detect('', 'https://blog.ejemplo.es/post')).toEqual({
      source: 'blog.ejemplo.es',
      medium: 'referral',
    });
  });

  it('ignora la propia web y las visitas directas', () => {
    expect(detect('', 'https://www.trasteros-garcia.com/precios')).toBeNull();
    expect(detect('', 'https://trasteros.pro/s/garcia')).toBeNull();
    expect(detect('', '')).toBeNull();
  });

  it('decodifica los valores del enlace', () => {
    expect(detect('?utm_source=flyer%20metro&utm_campaign=verano+2026')).toEqual({
      source: 'flyer metro',
      campaign: 'verano 2026',
    });
  });

  it('una campaña sin origen cuenta como web', () => {
    expect(detect('?utm_campaign=navidad')).toEqual({ source: 'web', campaign: 'navidad' });
  });
});

describe('sourceFromReferrer: correo y apps de Android', () => {
  const own = ['garcia.es'];
  it('un enlace de un email es «email», no búsqueda de Google', () => {
    expect(sourceFromReferrer('https://mail.google.com/mail/u/0/', own)).toEqual({
      source: 'gmail',
      medium: 'email',
    });
    expect(sourceFromReferrer('android-app://com.google.android.gm/', own)).toEqual({
      source: 'gmail',
      medium: 'email',
    });
  });
  it('las apps de Facebook e Instagram son sus redes', () => {
    expect(sourceFromReferrer('android-app://com.facebook.katana/', own)).toEqual({
      source: 'facebook',
      medium: 'social',
    });
    expect(sourceFromReferrer('android-app://com.instagram.android', own)).toEqual({
      source: 'instagram',
      medium: 'social',
    });
    expect(
      sourceFromReferrer('android-app://com.google.android.googlequicksearchbox/', own),
    ).toEqual({ source: 'google', medium: 'organic' });
  });
});

describe('sourceFromReferrer', () => {
  it('ignora referers que no son URL', () => {
    expect(sourceFromReferrer('nada', own)).toBeNull();
  });
});

describe('trafficSourceToUtm', () => {
  it('convierte al formato de los formularios', () => {
    expect(trafficSourceToUtm({ source: 'google', medium: 'cpc' })).toEqual({
      utmSource: 'google',
      utmMedium: 'cpc',
    });
    expect(trafficSourceToUtm(null)).toEqual({});
  });
});
