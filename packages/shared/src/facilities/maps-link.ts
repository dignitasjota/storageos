/**
 * Coordenadas de un enlace de Google Maps pegado por el operador. Los enlaces
 * cortos (`maps.app.goo.gl`) no las llevan: entonces solo sirve como enlace.
 */
export function coordinatesFromMapsUrl(
  url: string,
): { latitude: number; longitude: number } | null {
  const pair = (lat: string | undefined, lng: string | undefined) => {
    const latitude = Number(lat);
    const longitude = Number(lng);
    return Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
      ? { latitude, longitude }
      : null;
  };
  const number = '(-?\\d{1,3}(?:\\.\\d+)?)';
  // `!3d…!4d…` es el punto exacto del sitio; `@…` el centro del mapa.
  const patterns = [
    new RegExp(`!3d${number}!4d${number}`),
    new RegExp(`[?&](?:q|query|ll|destination)=${number}(?:,|%2C)${number}`, 'i'),
    new RegExp(`@${number},${number}`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    const found = match ? pair(match[1], match[2]) : null;
    if (found) return found;
  }
  return null;
}
