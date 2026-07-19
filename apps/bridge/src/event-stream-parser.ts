/**
 * Parser INCREMENTAL del stream `multipart/x-mixed-replace` que emite Dahua en
 * `snapManager.cgi?action=attachFileProc` (suscripción de eventos en tiempo
 * real). Formato confirmado con la doc oficial (`docs/vendor/…INTEGRATION-V1.0`):
 *
 *   --<boundary>\r\n
 *   Content-Type: text/plain\r\n
 *   Content-Length: <n>\r\n\r\n
 *   Events[0].Code=AccessControl
 *   Events[0].CardNo=12001
 *   ...
 *   --<boundary>\r\n
 *   Content-Type: image/jpeg\r\n
 *   Content-Length: <n>\r\n\r\n
 *   <JPEG binario>
 *   --<boundary>\r\n
 *   Content-Type: text/plain ... Heartbeat
 *
 * Se le van dando chunks (`push`) y emite bloques completos: cada parte de
 * eventos + el snapshot que la sigue (si lo hay). Los "Heartbeat" se descartan.
 */
export interface DahuaEvent {
  /** `Events[i].Code` (AccessControl, VideoMotion, …). */
  code: string;
  /** Resto de campos `Events[i].Campo` → valor (CardNo, Method, Status…). */
  fields: Record<string, string>;
}

export interface DahuaStreamBlock {
  events: DahuaEvent[];
  /** Snapshot JPEG asociado al bloque, o null. */
  jpeg: Buffer | null;
}

interface ParsedPart {
  contentType: string;
  body: Buffer;
}

export class DahuaEventStreamParser {
  private buf = Buffer.alloc(0);
  private boundary: Buffer | null = null;
  /** Eventos de la última parte de texto, a la espera de su posible snapshot. */
  private pendingEvents: DahuaEvent[] | null = null;

  constructor(boundary?: string) {
    if (boundary) this.boundary = Buffer.from(`--${boundary}`);
  }

  /** Alimenta el parser con un chunk del stream y devuelve los bloques completos. */
  push(chunk: Buffer): DahuaStreamBlock[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.boundary) this.detectBoundary();
    if (!this.boundary) return [];

    const blocks: DahuaStreamBlock[] = [];
    let part: ParsedPart | null;
    while ((part = this.nextPart()) !== null) {
      const emitted = this.consumePart(part);
      if (emitted) blocks.push(emitted);
    }
    return blocks;
  }

  /** Vacía cualquier bloque de eventos pendiente sin snapshot (fin de stream). */
  flush(): DahuaStreamBlock[] {
    if (this.pendingEvents && this.pendingEvents.length > 0) {
      const b: DahuaStreamBlock = { events: this.pendingEvents, jpeg: null };
      this.pendingEvents = null;
      return [b];
    }
    return [];
  }

  private detectBoundary(): void {
    // La 1ª línea del stream es `--<boundary>`.
    const nl = this.buf.indexOf('\r\n');
    if (nl < 0) return;
    const first = this.buf.subarray(0, nl).toString('latin1').trim();
    if (first.startsWith('--')) this.boundary = Buffer.from(first);
  }

  /** Extrae la siguiente parte completa (headers + body) si está entera en el buffer. */
  private nextPart(): ParsedPart | null {
    if (!this.boundary) return null;
    const start = this.buf.indexOf(this.boundary);
    if (start < 0) return null;
    const headerStart = start + this.boundary.length;
    // Fin de cabeceras = primer \r\n\r\n tras el boundary.
    const headerEnd = this.buf.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0) return null;
    const headers = this.buf.subarray(headerStart, headerEnd).toString('latin1');
    const bodyStart = headerEnd + 4;
    const lenMatch = /content-length:\s*(\d+)/i.exec(headers);
    const ctMatch = /content-type:\s*([^\r\n;]+)/i.exec(headers);
    if (!lenMatch) return null; // cabeceras aún incompletas
    const length = Number(lenMatch[1]);
    if (this.buf.length < bodyStart + length) return null; // body aún incompleto
    const body = this.buf.subarray(bodyStart, bodyStart + length);
    this.buf = this.buf.subarray(bodyStart + length);
    return { contentType: (ctMatch?.[1] ?? '').trim().toLowerCase(), body: Buffer.from(body) };
  }

  private consumePart(part: ParsedPart): DahuaStreamBlock | null {
    if (part.contentType.startsWith('image/')) {
      // Snapshot: se adjunta a los eventos pendientes y emite el bloque.
      const events = this.pendingEvents ?? [];
      this.pendingEvents = null;
      return events.length > 0 ? { events, jpeg: part.body } : null;
    }
    // text/plain: puede ser "Heartbeat" o un set de Events[i].*
    const text = part.body.toString('utf8');
    if (/^\s*Heartbeat\s*$/.test(text)) return null;
    const events = DahuaEventStreamParser.parseEvents(text);
    if (events.length === 0) return null;
    // Si ya había eventos pendientes sin imagen, emítelos antes (sin snapshot).
    let flushed: DahuaStreamBlock | null = null;
    if (this.pendingEvents && this.pendingEvents.length > 0) {
      flushed = { events: this.pendingEvents, jpeg: null };
    }
    this.pendingEvents = events;
    return flushed;
  }

  /** Parsea el cuerpo key=value `Events[i].Campo=valor` → lista de eventos. */
  static parseEvents(text: string): DahuaEvent[] {
    const byIndex = new Map<number, DahuaEvent>();
    for (const line of text.split(/\r?\n/)) {
      const m = /^Events\[(\d+)\]\.([A-Za-z0-9_.]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const idx = Number(m[1]);
      const field = m[2] as string;
      const value = (m[3] ?? '').trim();
      let ev = byIndex.get(idx);
      if (!ev) {
        ev = { code: '', fields: {} };
        byIndex.set(idx, ev);
      }
      if (field === 'Code') ev.code = value;
      else ev.fields[field] = value;
    }
    return [...byIndex.values()].filter((e) => e.code !== '' || Object.keys(e.fields).length > 0);
  }
}
