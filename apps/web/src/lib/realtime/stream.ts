import type { RealtimeEventDto } from '@storageos/shared';

const RETRY_MS = 5_000;

/**
 * Escucha un canal en vivo del API hasta que se aborta. Se reconecta solo: el
 * servidor corta cada poco para que el token siga vigente, y una caída solo
 * retrasa los avisos hasta el siguiente refresco.
 */
export async function listenRealtime(
  open: (signal: AbortSignal) => Promise<Response>,
  onEvent: (event: RealtimeEventDto) => void,
  onStatus: (connected: boolean) => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await open(signal);
      if (res.ok && res.body) {
        onStatus(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            if (part.startsWith('data: ')) {
              onEvent(JSON.parse(part.slice('data: '.length)) as RealtimeEventDto);
            }
          }
        }
      }
    } catch {
      /* se reintenta */
    }
    onStatus(false);
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}
