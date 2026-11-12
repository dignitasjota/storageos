import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { useFacilities } from './hooks';

interface FacilityState {
  /** id de la facility seleccionada en AppHeader. `null` = "Todas". */
  currentFacilityId: string | null;
  setCurrentFacility: (id: string | null) => void;
}

export const useFacilityStore = create<FacilityState>()(
  persist(
    (set) => ({
      currentFacilityId: null,
      setCurrentFacility: (id) => set({ currentFacilityId: id }),
    }),
    { name: 'storageos.facility' },
  ),
);

/**
 * Local elegido en el selector de la cabecera (`undefined` = todos). Con un
 * solo local no filtra: elegirlo es lo mismo que «Todos», y así no se pierde lo
 * que no tiene local (inquilinos sin trastero, facturas de toda la empresa).
 */
export function useHeaderFacilityId(): string | undefined {
  const stored = useFacilityStore((s) => s.currentFacilityId);
  const facilities = useFacilities();
  if (!stored) return undefined;
  if (facilities.data && facilities.data.length <= 1) return undefined;
  return stored;
}

/**
 * Filtro de local de una página: empieza con el de la cabecera y lo sigue
 * cuando cambia (la página puede elegir otro sin tocar la cabecera).
 */
export function useFacilityFilterState(): [string | undefined, (id: string | undefined) => void] {
  const header = useHeaderFacilityId();
  const [value, setValue] = useState<string | undefined>(header);
  useEffect(() => setValue(header), [header]);
  return [value, setValue];
}
