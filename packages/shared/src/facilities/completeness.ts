import { hasOpeningHours } from './opening-hours';

import type { OpeningHours } from './schemas';

export type FacilityCheckKey = 'photo' | 'hours' | 'address' | 'phone' | 'map' | 'directions';

export const FACILITY_CHECK_LABELS: Record<FacilityCheckKey, string> = {
  photo: 'Una foto del local',
  hours: 'El horario',
  address: 'La dirección',
  phone: 'Un teléfono',
  map: 'La ubicación en el mapa',
  directions: 'Cómo llegar',
};

/** Lo que hace falta para que la ficha pública del local esté completa. */
export function facilityCompleteness(f: {
  images: unknown[];
  openingHours: OpeningHours | null | undefined;
  address: string | null;
  contactPhone: string | null;
  latitude: number | null;
  directions: string | null;
}): { percent: number; missing: FacilityCheckKey[] } {
  const checks: [FacilityCheckKey, boolean][] = [
    ['photo', f.images.length > 0],
    ['hours', hasOpeningHours(f.openingHours)],
    ['address', !!f.address],
    ['phone', !!f.contactPhone],
    ['map', f.latitude != null],
    ['directions', !!f.directions],
  ];
  const missing = checks.filter(([, done]) => !done).map(([key]) => key);
  return {
    percent: Math.round(((checks.length - missing.length) / checks.length) * 100),
    missing,
  };
}
