import { DahuaEventStreamParser } from '../src/event-stream-parser';

/** Construye una parte multipart (headers + body) con el formato de Dahua. */
function part(boundary: string, contentType: string, body: Buffer | string): Buffer {
  const b = typeof body === 'string' ? Buffer.from(body) : body;
  const head = `--${boundary}\r\nContent-Type: ${contentType}\r\nContent-Length: ${b.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head), b]);
}

describe('DahuaEventStreamParser', () => {
  const BOUNDARY = 'myboundary';

  it('parseEvents: agrupa Events[i].Campo por índice (formato de la doc)', () => {
    const text = [
      'Events[0].Code=AccessControl',
      'Events[0].CardNo=12001',
      'Events[0].Method=1',
      'Events[0].Status=1',
      'Events[1].Code=AccessControl',
      'Events[1].CardNo=99999',
    ].join('\r\n');
    const events = DahuaEventStreamParser.parseEvents(text);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ code: 'AccessControl', fields: { CardNo: '12001', Method: '1' } });
    expect(events[1]?.fields.CardNo).toBe('99999');
  });

  it('emite un bloque con eventos + el snapshot JPEG que le sigue', () => {
    const parser = new DahuaEventStreamParser(BOUNDARY);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // cabecera JPEG
    const stream = Buffer.concat([
      part(BOUNDARY, 'text/plain', 'Events[0].Code=AccessControl\r\nEvents[0].CardNo=12001'),
      part(BOUNDARY, 'image/jpeg', jpeg),
    ]);
    const blocks = parser.push(stream);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.events[0]?.code).toBe('AccessControl');
    expect(blocks[0]?.jpeg?.equals(jpeg)).toBe(true);
  });

  it('descarta los "Heartbeat" y emite eventos sin snapshot al flush', () => {
    const parser = new DahuaEventStreamParser(BOUNDARY);
    const stream = Buffer.concat([
      part(BOUNDARY, 'text/plain', 'Heartbeat'),
      part(BOUNDARY, 'text/plain', 'Events[0].Code=VideoMotion'),
    ]);
    // El heartbeat no emite; el evento queda pendiente (sin imagen aún).
    expect(parser.push(stream)).toHaveLength(0);
    // Al cerrar el stream, el evento pendiente se emite sin snapshot.
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.events[0]?.code).toBe('VideoMotion');
    expect(flushed[0]?.jpeg).toBeNull();
  });

  it('es incremental: reconstruye un bloque partido en varios chunks', () => {
    const parser = new DahuaEventStreamParser(BOUNDARY);
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03]);
    const full = Buffer.concat([
      part(BOUNDARY, 'text/plain', 'Events[0].Code=AlarmLocal'),
      part(BOUNDARY, 'image/jpeg', jpeg),
    ]);
    // Trocea el stream en mitades arbitrarias.
    const mid = Math.floor(full.length / 2);
    expect(parser.push(full.subarray(0, mid))).toHaveLength(0);
    const blocks = parser.push(full.subarray(mid));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.events[0]?.code).toBe('AlarmLocal');
    expect(blocks[0]?.jpeg?.equals(jpeg)).toBe(true);
  });
});
