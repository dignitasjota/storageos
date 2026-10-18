import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

/** Local elegido en el selector de la cabecera (`undefined` = todos). */
export function useHeaderFacilityId(): string | undefined {
  return useFacilityStore((s) => s.currentFacilityId) ?? undefined;
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
