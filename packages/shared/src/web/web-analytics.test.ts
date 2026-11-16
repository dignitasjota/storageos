import { describe, expect, it } from 'vitest';

import {
  contactKindFromHref,
  deviceFromUserAgent,
  isBotUserAgent,
  isValidWebPath,
  normalizeWebPath,
} from './web-analytics';

describe('normalizeWebPath', () => {
  it('quita el prefijo de la plataforma', () => {
    expect(normalizeWebPath('/s/garcia', 'garcia')).toBe('/');
    expect(normalizeWebPath('/s/garcia/precios/', 'garcia')).toBe('/precios');
    expect(normalizeWebPath('/book/garcia', 'garcia')).toBe('/reservar');
    // La misma página en otro idioma cuenta como la misma.
    expect(normalizeWebPath('/book/garcia/l/en', 'garcia')).toBe('/reservar');
    expect(normalizeWebPath('/s/garcia/l/en/precios', 'garcia')).toBe('/precios');
    expect(normalizeWebPath('/l/en', 'garcia')).toBe('/');
    expect(normalizeWebPath('/blog/l/entrada', 'garcia')).toBe('/blog/l/entrada');
  });

  it('solo valen rutas de la web', () => {
    expect(isValidWebPath('/trasteros-en-mislata')).toBe(true);
    expect(isValidWebPath('/precios')).toBe(true);
    expect(isValidWebPath('/<script>')).toBe(false);
    expect(isValidWebPath('/con espacio')).toBe(false);
  });

  it('deja tal cual las rutas del dominio propio', () => {
    expect(normalizeWebPath('/trasteros-en-mislata?utm_source=x', 'garcia')).toBe(
      '/trasteros-en-mislata',
    );
    expect(normalizeWebPath('/s/garciaplus/x', 'garcia')).toBe('/s/garciaplus/x');
    expect(normalizeWebPath('', 'garcia')).toBe('/');
  });
});

describe('deviceFromUserAgent', () => {
  it('distingue móvil, tableta y ordenador', () => {
    expect(
      deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'),
    ).toBe('mobile');
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari')).toBe(
      'mobile',
    );
    expect(deviceFromUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('tablet');
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) Safari')).toBe('tablet');
    expect(deviceFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari')).toBe(
      'desktop',
    );
  });
});

describe('isBotUserAgent', () => {
  it('descarta robots y previsualizaciones', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBotUserAgent('facebookexternalhit/1.1')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
    expect(isBotUserAgent('TelegramBot (like TwitterBot)')).toBe(true);
    expect(isBotUserAgent('AdsBot-Google (+http://www.google.com/adsbot.html)')).toBe(true);
    expect(
      isBotUserAgent(
        'Mozilla/5.0 (Linux; Android 6.0.1) Chrome/120 Mobile (compatible; AdsBot-Google-Mobile)',
      ),
    ).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Google-InspectionTool/1.0)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (compatible; GoogleOther)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 GTmetrix')).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    // Un móvil Cubot no es un robot.
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 13; Cubot_X70) Mobile')).toBe(false);
    expect(isBotUserAgent('Mozilla/5.0 (iPhone) Mobile/15E148 Safari/604.1')).toBe(false);
  });
});

describe('contactKindFromHref', () => {
  it('reconoce llamadas, WhatsApp, email y cómo llegar', () => {
    expect(contactKindFromHref('tel:+34600000000')).toBe('call_click');
    expect(contactKindFromHref('https://wa.me/34600000000?text=Hola')).toBe('whatsapp_click');
    expect(contactKindFromHref('https://api.whatsapp.com/send?phone=34')).toBe('whatsapp_click');
    expect(contactKindFromHref('mailto:hola@x.es')).toBe('email_click');
    expect(contactKindFromHref('https://www.google.com/maps/dir/?api=1&destination=x')).toBe(
      'directions_click',
    );
    expect(contactKindFromHref('https://maps.app.goo.gl/abc')).toBe('directions_click');
    expect(contactKindFromHref('/reservar')).toBeNull();
    expect(contactKindFromHref('https://instagram.com/garcia')).toBeNull();
  });
});
