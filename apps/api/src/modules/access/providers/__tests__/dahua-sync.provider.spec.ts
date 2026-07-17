import { createServer, type Server } from 'node:http';

import { DahuaSyncProvider } from '../dahua-sync.provider';

import type { AddressInfo } from 'node:net';

/**
 * Unit del adapter de sync Dahua. Los formatos (campos de AccessControlCard,
 * body key=value de recordFinder) están confirmados con la doc oficial
 * `docs/vendor/DAHUA-ACCESS-CONTROL-INTEGRATION-V1.0.pdf`.
 */
describe('DahuaSyncProvider', () => {
  const provider = new DahuaSyncProvider();
  const noDevice = { id: 'd', hardwareId: 'hw', channel: 1, controlUrl: null, controlSecret: null };

  const pinSpec = {
    credentialId: 'cred-abc',
    customerId: 'cust',
    method: 'pin' as const,
    secret: '1234',
    label: null,
    state: 'active' as const,
  };

  it('sin controlUrl/creds → push devuelve un ref determinista sin lanzar', async () => {
    const r1 = await provider.pushCredential(noDevice, pinSpec);
    const r2 = await provider.pushCredential(noDevice, pinSpec);
    expect(r1.ref).toBe(r2.ref); // determinista por credentialId
    expect(r1.ref).toMatch(/^\d+$/);
  });

  it('rfid/qr usan el secreto como CardNo (el UID físico casa con los eventos)', async () => {
    const rfid = await provider.pushCredential(noDevice, {
      ...pinSpec,
      method: 'rfid',
      secret: 'A1B2C3D4',
    });
    expect(rfid.ref).toBe('A1B2C3D4');
    const qr = await provider.pushCredential(noDevice, { ...pinSpec, method: 'qr', secret: 'tok9' });
    expect(qr.ref).toBe('tok9');
  });

  it('setState/remove/pullEvents no lanzan sin device configurado', async () => {
    await expect(provider.setState(noDevice, '1', 'suspended')).resolves.toBeUndefined();
    await expect(provider.remove(noDevice, '1')).resolves.toBeUndefined();
    await expect(provider.pullEvents(noDevice, null)).resolves.toEqual([]);
  });

  it('parseRecords: body key=value del ejemplo EXACTO de la doc oficial', () => {
    const body = [
      'totalCount=1000',
      'found=100',
      'records[0].RecNo=12345',
      'records[0].CreateTime=123456789',
      'records[0].CardNo=12001',
      'records[0].CardName=ZhangSan',
      'records[0].UserID=ZhangSan',
      'records[0].Type=Entry',
      'records[0].Method=1',
      'records[1].RecNo=13579',
      'records[1].CreateTime=123456799',
      'records[1].CardNo=12001',
      'records[1].Type=Exit',
      'records[1].Method=0',
    ].join('\r\n');
    const rows = DahuaSyncProvider.parseRecords(body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ RecNo: '12345', CardNo: '12001', Method: '1' });
    expect(rows[1]).toMatchObject({ RecNo: '13579', Type: 'Exit', Method: '0' });
  });

  describe('contra un terminal simulado (Digest)', () => {
    let server: Server;
    let device: {
      id: string;
      hardwareId: string;
      channel: number;
      controlUrl: string | null;
      controlSecret: string | null;
    };
    const urls: string[] = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        const url = req.url ?? '';
        if (!req.headers.authorization) {
          res.writeHead(401, {
            'www-authenticate': 'Digest realm="Login to ASI", qop="auth", nonce="n1"',
          });
          res.end();
          return;
        }
        urls.push(url);
        res.writeHead(200);
        if (url.includes('recordUpdater.cgi') && url.includes('action=insert')) {
          res.end('RecNo=777'); // el insert responde el nº de registro
          return;
        }
        if (url.includes('recordFinder.cgi') && url.includes('name=AccessControlCard&')) {
          // Falta el AccessControlCardRec: es la búsqueda del recno de la card.
          res.end('found=1\r\nrecords[0].RecNo=777\r\nrecords[0].CardNo=12001');
          return;
        }
        if (url.includes('recordFinder.cgi') && url.includes('AccessControlCardRec')) {
          res.end(
            [
              'found=2',
              'records[0].RecNo=1',
              'records[0].CreateTime=1760700000',
              'records[0].CardNo=12001',
              'records[0].Method=1',
              'records[0].Status=1',
              'records[1].RecNo=2',
              'records[1].CreateTime=1760700100',
              'records[1].CardNo=99999',
              'records[1].Method=0',
              'records[1].Status=0',
              'records[1].ErrorCode=64',
            ].join('\r\n'),
          );
          return;
        }
        res.end('OK');
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      device = {
        id: 'd1',
        hardwareId: 'asi-1',
        channel: 1,
        controlUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        controlSecret: 'admin:pw',
      };
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('push de un PIN envía Password + CardNo + CardStatus por recordUpdater', async () => {
      urls.length = 0;
      const { ref } = await provider.pushCredential(device, pinSpec);
      expect(ref).toMatch(/^\d+$/);
      const insert = urls.find((u) => u.includes('action=insert'));
      expect(insert).toBeDefined();
      expect(insert).toContain('name=AccessControlCard');
      expect(insert).toContain(`CardNo=${ref}`);
      expect(insert).toContain('Password=1234'); // el PIN viaja en Password
      expect(insert).toContain('CardStatus=0');
    });

    it('setState resuelve el recno vía recordFinder y actualiza CardStatus=8 (impago)', async () => {
      urls.length = 0;
      await provider.setState(device, '12001', 'suspended');
      const find = urls.find((u) => u.includes('recordFinder.cgi'));
      expect(find).toContain('condition.CardNo=12001');
      const update = urls.find((u) => u.includes('action=update'));
      expect(update).toContain('recno=777');
      expect(update).toContain('CardStatus=8'); // Arrearage
    });

    it('remove borra por recno', async () => {
      urls.length = 0;
      await provider.remove(device, '12001');
      const remove = urls.find((u) => u.includes('action=remove'));
      expect(remove).toContain('recno=777');
    });

    it('pullEvents parsea los registros → eventos con método/permitido/fecha', async () => {
      const events = await provider.pullEvents(device, new Date('2026-07-17T00:00:00Z'));
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ credentialRef: '12001', method: 'rfid', allowed: true });
      expect(events[0]?.occurredAt.getTime()).toBe(1760700000 * 1000);
      // Method=0 (password) → pin; Status=0 → denegado; ErrorCode en el raw.
      expect(events[1]).toMatchObject({ credentialRef: '99999', method: 'pin', allowed: false });
      expect(events[1]?.raw).toMatchObject({ errorCode: '64' });
    });
  });
});
