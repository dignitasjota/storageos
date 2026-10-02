import { createServer, type Server } from 'node:http';

export type HoldedCall = { method: string; path: string; body: Record<string, unknown> | null };

/**
 * Fallo inyectado para la siguiente petición que encaje: responder con un
 * estado de error, cortar la conexión (error de red: la app no sabe si Holded
 * la procesó) o tardar en responder.
 */
export type HoldedFault = {
  match: (method: string, path: string) => boolean;
  status?: number;
  drop?: boolean;
  delayMs?: number;
  /** Veces que se aplica (por defecto 1). */
  times?: number;
};

/** Holded simulado (API v2): registra las llamadas y responde lo mínimo. */
export function fakeHolded(): Promise<{
  server: Server;
  base: string;
  calls: HoldedCall[];
  faults: HoldedFault[];
}> {
  const calls: HoldedCall[] = [];
  const faults: HoldedFault[] = [];
  let seq = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => void handle());
    const handle = async () => {
      const path = (req.url ?? '').replace(/^\/api\/v2/, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const method = req.method ?? 'GET';
      calls.push({ method, path, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const fault = faults.find((f) => f.match(method, path) && (f.times ?? 1) > 0);
      if (fault) {
        fault.times = (fault.times ?? 1) - 1;
        if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
        if (fault.drop) return req.socket.destroy();
        if (fault.status) return send(fault.status, { message: 'Error simulado' });
      }
      if (path.startsWith('/numbering-series/invoice')) {
        return send(200, {
          items: [
            { id: 'ser-vf', name: 'Normal', format: 'F%%%%', verifactu_excluded: false },
            { id: 'ser-ok', name: 'TrasterOS', format: 'TRA%%%%', verifactu_excluded: true },
          ],
        });
      }
      if (path.startsWith('/numbering-series/creditnote')) {
        return send(200, {
          items: [
            { id: 'ser-r', name: 'Rect TrasterOS', format: 'RTR%%%', verifactu_excluded: true },
          ],
        });
      }
      if (path.startsWith('/taxes')) {
        return send(200, {
          items: [
            { key: 's_iva_21', amount: 21 },
            { key: 's_iva_0', amount: 0 },
          ],
        });
      }
      if (req.method === 'GET' && path.startsWith('/contacts')) return send(200, { items: [] });
      if (req.method === 'POST' && path === '/contacts') return send(201, { id: `c-${++seq}` });
      if (req.method === 'POST' && path === '/invoices') return send(201, { id: `inv-${++seq}` });
      if (req.method === 'POST' && path === '/credit-notes')
        return send(201, { id: `cn-${++seq}` });
      return send(200, {});
    };
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}/api/v2`, calls, faults });
    }),
  );
}
