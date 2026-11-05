import { create } from 'zustand';

/** Si el canal en vivo está abierto, los refrescos periódicos se espacian. */
export const useRealtimeStore = create<{
  connected: boolean;
  setConnected: (connected: boolean) => void;
}>((set) => ({
  connected: false,
  setConnected: (connected) => set({ connected }),
}));

/** Cada cuánto refrescar una lista que también llega por el canal en vivo. */
export function liveRefetchInterval(ms = 20_000): () => number {
  return () => (useRealtimeStore.getState().connected ? 120_000 : ms);
}
