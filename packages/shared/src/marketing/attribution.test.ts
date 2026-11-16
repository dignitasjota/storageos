import { describe, expect, it } from 'vitest';

import {
  attributeChannel,
  channelSourceConflicts,
  channelSources,
  defaultChannelSource,
  isPaidMedium,
  normalizeTrafficSource,
  trafficKey,
  type AttributableChannel,
} from './attribution';

const channel = (over: Partial<AttributableChannel> & { id: string }): AttributableChannel => ({
  name: over.id,
  type: 'other',
  status: 'active',
  utmSourceMatch: null,
  externalCampaignId: null,
  externalUrl: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('atribución a canales de marketing', () => {
  it('distingue el tráfico de pago y unifica los alias', () => {
    expect(isPaidMedium('cpc')).toBe(true);
    expect(isPaidMedium('paid_social')).toBe(true);
    expect(isPaidMedium('organic')).toBe(false);
    expect(isPaidMedium(null)).toBe(false);
    expect(normalizeTrafficSource('IG')).toBe('instagram');
    expect(normalizeTrafficSource('fb')).toBe('facebook');
    expect(normalizeTrafficSource('')).toBe('web');
    expect(trafficKey({ source: 'ig', medium: 'paid' })).toEqual({ source: 'meta', paid: true });
    expect(trafficKey({ source: 'instagram', medium: 'social' })).toEqual({
      source: 'instagram',
      paid: false,
    });
  });

  it('un canal de Google Ads solo recoge el tráfico de pago de Google', () => {
    const ads = channel({
      id: 'ads',
      type: 'google_ads',
      utmSourceMatch: 'google_ads_local_norte',
    });
    expect(channelSources(ads)).toContain('google');
    expect(attributeChannel([ads], { source: 'google', medium: 'cpc' })?.id).toBe('ads');
    expect(attributeChannel([ads], { source: 'google', medium: 'organic' })).toBeNull();
  });

  it('Meta Ads recoge los anuncios de Facebook e Instagram, no las publicaciones', () => {
    const meta = channel({ id: 'meta', type: 'meta_ads' });
    expect(attributeChannel([meta], { source: 'ig', medium: 'paid' })?.id).toBe('meta');
    expect(attributeChannel([meta], { source: 'facebook', medium: 'cpc' })?.id).toBe('meta');
    expect(attributeChannel([meta], { source: 'instagram', medium: 'social' })).toBeNull();
  });

  it('un portal se reconoce por su nombre aunque el origen escrito sea otro', () => {
    const portal = channel({
      id: 'p',
      type: 'real_estate_portal',
      name: 'Idealista — anuncio Local Norte',
      utmSourceMatch: 'idealista_anuncio_local_norte',
    });
    expect(attributeChannel([portal], { source: 'idealista', medium: 'referral' })?.id).toBe('p');
    expect(
      defaultChannelSource({
        type: 'real_estate_portal',
        name: 'Fotocasa Norte',
        fallback: 'x',
      }),
    ).toBe('fotocasa');
    expect(defaultChannelSource({ type: 'google_ads', name: 'Lo que sea', fallback: 'x' })).toBe(
      'google',
    );
  });

  it('la campaña del enlace manda sobre el origen', () => {
    const a = channel({ id: 'a', type: 'google_ads' });
    const b = channel({ id: 'b', type: 'google_ads', externalCampaignId: '9876' });
    expect(
      attributeChannel([a, b], { source: 'google', medium: 'cpc', campaign: '9876' })?.id,
    ).toBe('b');
    expect(attributeChannel([a, b], { source: 'qr', medium: 'offline', campaign: 'A' })?.id).toBe(
      'a',
    );
  });

  it('con dos canales del mismo origen, siempre el mismo (activo y más antiguo) y se avisa', () => {
    const older = channel({ id: 'old', type: 'google_ads', createdAt: '2026-01-01T00:00:00Z' });
    const newer = channel({ id: 'new', type: 'google_ads', createdAt: '2026-02-01T00:00:00Z' });
    const paused = channel({
      id: 'paused',
      type: 'google_ads',
      status: 'paused',
      createdAt: '2025-01-01T00:00:00Z',
    });
    const touch = { source: 'google', medium: 'cpc' };
    expect(attributeChannel([newer, paused, older], touch)?.id).toBe('old');
    expect(attributeChannel([older, newer], touch)?.id).toBe('old');
    const conflicts = channelSourceConflicts([older, newer]);
    expect(conflicts.get('new')).toBe('old');
    expect(conflicts.get('old')).toBe('new');
  });

  it('un canal de anuncios y uno normal del mismo origen no chocan', () => {
    const ads = channel({ id: 'ads', type: 'google_ads' });
    const plain = channel({ id: 'plain', utmSourceMatch: 'google' });
    expect(attributeChannel([ads, plain], { source: 'google', medium: 'cpc' })?.id).toBe('ads');
    expect(attributeChannel([ads, plain], { source: 'google', medium: 'organic' })?.id).toBe(
      'plain',
    );
    expect(channelSourceConflicts([ads, plain]).size).toBe(0);
  });
});
