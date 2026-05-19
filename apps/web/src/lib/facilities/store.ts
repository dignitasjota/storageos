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
