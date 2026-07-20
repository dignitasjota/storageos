import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  CredentialSyncProvider,
  type SyncAccessEvent,
  type SyncCredentialSpec,
  type SyncDevice,
  type SyncState,
} from './credential-sync-provider';
import { digestRequest } from './digest-fetch';

/**
 * Sincronización de credenciales contra terminales **Dahua** (series ASI3XXX/
 * ASI6XXX/ASI7XXX) por `recordUpdater.cgi` / `recordFinder.cgi` con Digest
 * (Patrón B).
 *
 * Campos y formatos CONFIRMADOS con la doc oficial «DAHUA ACCESS CONTROL
 * PRODUCTS INTEGRATION INSTRUCTION v1.0» (2021-09-28, `docs/vendor/
 * DAHUA-ACCESS-CONTROL-INTEGRATION-V1.0.pdf`):
 *   - Alta:    `recordUpdater.cgi?action=insert&name=AccessControlCard` con
 *              CardNo (req), UserID (req), CardName, CardStatus, CardType,
 *              **Password** (el PIN de la credencial), ValidDateStart/End…
 *              → responde `RecNo=<n>` en el body.
 *   - CardStatus (bitmask): 0 Normal · 1 Loss · 2 Canceled · 4 Frozen ·
 *              **8 Arrearage (impago)** · 16 Overdue · 32 Pre-arrearage.
 *   - Logs:    `recordFinder.cgi?action=find&name=AccessControlCardRec` con
 *              StartTime/EndTime (epoch s) → body key=value `records[i].Campo`
 *              (RecNo/CreateTime/CardNo/UserID/Type/Status/Method/Door…).
 *   - Apertura remota: `accessControl.cgi?action=openDoor&channel=N&Type=Remote`
 *              (en `DahuaLockProvider`).
 *
 * Lo único pendiente de validar con el terminal FÍSICO (smoke): que update/
 * remove de `AccessControlCard` operen por `recno` en el firmware concreto
 * (aquí se resuelve el recno vía recordFinder y hay fallback por CardNo).
 */
@Injectable()
export class DahuaSyncProvider extends CredentialSyncProvider {
  private readonly logger = new Logger(DahuaSyncProvider.name);

  get name(): string {
    return 'dahua-sync';
  }

  /** Estado nuestro → `CardStatus` de Dahua (confirmado con la doc v1.0). */
  private cardStatus(state: SyncState): number {
    if (state === 'suspended') return 8; // 1<<3 Arrearage (impago)
    if (state === 'revoked') return 2; // 1<<1 Canceled
    return 0; // Normal
  }

  /**
   * CardNo de la credencial en el terminal.
   *  - `rfid`: el UID físico de la tarjeta (así el swipe casa y los eventos
   *    reportan ese mismo CardNo).
   *  - `qr`: el token del QR (los ASI con lector QR resuelven el código a un
   *    CardNo; el campo es string según la doc).
   *  - `pin`: un nº determinista derivado del credentialId (la validación real
   *    del PIN va por el campo `Password`).
   */
  private cardNo(cred: SyncCredentialSpec): string {
    if (cred.method === 'rfid' || cred.method === 'qr') return cred.secret;
    const h = createHash('sha1').update(cred.credentialId).digest('hex').slice(0, 8);
    return (parseInt(h, 16) % 1_000_000_0000).toString();
  }

  private creds(device: SyncDevice): { user: string; pass: string } | null {
    if (!device.controlUrl || !device.controlSecret?.includes(':')) return null;
    const [user, ...rest] = device.controlSecret.split(':');
    return { user: user as string, pass: rest.join(':') };
  }

  private base(device: SyncDevice): string {
    return (device.controlUrl ?? '').replace(/\/+$/, '');
  }

  /**
   * Fecha en el formato de Dahua `yyyyMMdd HHmmss` (doc v1.0), en la HORA LOCAL
   * del terminal (la timezone del local): el terminal compara contra su reloj.
   */
  static formatDahuaDate(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
    // `hour12:false` puede dar "24" a medianoche según runtime → normaliza a 00.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}${get('month')}${get('day')} ${hour}${get('minute')}${get('second')}`;
  }

  /**
   * Parsea un body key=value de Dahua (`records[i].Campo=valor` + `found=N`)
   * → array de registros. Formato confirmado con la doc v1.0.
   */
  static parseRecords(body: string): Array<Record<string, string>> {
    const rows: Array<Record<string, string>> = [];
    for (const line of body.split(/\r?\n/)) {
      const m = /^records\[(\d+)\]\.([A-Za-z0-9_.]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const idx = Number(m[1]);
      rows[idx] = rows[idx] ?? {};
      (rows[idx] as Record<string, string>)[m[2] as string] = (m[3] ?? '').trim();
    }
    return rows.filter(Boolean);
  }

  /** Busca el `recno` del registro AccessControlCard de un CardNo (para update/remove). */
  private async findRecno(
    device: SyncDevice,
    c: { user: string; pass: string },
    cardNo: string,
  ): Promise<string | null> {
    const params = new URLSearchParams({
      action: 'find',
      name: 'AccessControlCard',
      'condition.CardNo': cardNo,
      count: '1',
    });
    const res = await digestRequest({
      url: `${this.base(device)}/cgi-bin/recordFinder.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) return null;
    const rec = DahuaSyncProvider.parseRecords(res.body)[0];
    return rec?.RecNo ?? null;
  }

  /**
   * Alta de una plantilla FACIAL en el terminal (`FaceInfoManager.cgi?action=add`,
   * doc v1.0 §Face): la cara se vincula a un `UserID`; el terminal hace el matching
   * offline (Patrón B). La foto va en base64 (≤100 KB según la doc).
   *
   * ⚠️ Los nombres exactos de los campos del insert facial (PhotoData vs Photo,
   * multipart vs base64 en query) dependen del firmware → marcado VERIFY para el
   * smoke con el terminal físico. El `ref` persistido es el UserID (estable).
   */
  private async pushFace(
    device: SyncDevice,
    cred: SyncCredentialSpec,
    c: { user: string; pass: string },
  ): Promise<{ ref: string }> {
    const userId = cred.customerId.replace(/-/g, '').slice(0, 20);
    const params = new URLSearchParams({
      action: 'add',
      // VERIFY firmware: algunos exponen `UserID`, otros `PhotoData.UserID`.
      UserID: userId,
      // VERIFY firmware: la foto puede ir como base64 en query (`PhotoData`) o
      // como multipart. Aquí base64 en query (scaffold).
      ...(cred.photoBase64 ? { PhotoData: cred.photoBase64 } : {}),
    });
    const res = await digestRequest({
      url: `${this.base(device)}/cgi-bin/FaceInfoManager.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) this.logger.warn(`[dahua-sync] pushFace ${device.hardwareId} → ${res.status}`);
    return { ref: userId };
  }

  async pushCredential(device: SyncDevice, cred: SyncCredentialSpec): Promise<{ ref: string }> {
    const c = this.creds(device);
    if (cred.method === 'face') {
      const userId = cred.customerId.replace(/-/g, '').slice(0, 20);
      if (!c || !device.controlUrl) return { ref: userId };
      return this.pushFace(device, cred, c);
    }
    const cardNo = this.cardNo(cred);
    if (!c || !device.controlUrl) return { ref: cardNo };
    const params = new URLSearchParams({
      action: 'insert',
      name: 'AccessControlCard',
      CardNo: cardNo,
      UserID: cred.customerId.replace(/-/g, '').slice(0, 20),
      CardName: (cred.label ?? cred.customerId).slice(0, 32),
      CardStatus: String(this.cardStatus(cred.state)),
      CardType: '0',
      // El PIN viaja en `Password` (doc v1.0: «the password when unlocking»).
      // Para rfid/qr el propio CardNo es el secreto; no llevan Password.
      ...(cred.method === 'pin' ? { Password: cred.secret } : {}),
      // Caducidad (pases nocturnos, accesos temporales): el terminal desactiva
      // la card al expirar (`IsValid` → false, doc v1.0). En hora local del local.
      ...(cred.validUntil
        ? { ValidDateEnd: DahuaSyncProvider.formatDahuaDate(cred.validUntil, device.timezone) }
        : {}),
      // Límite de usos (pase single-use). La doc v1.0 confirma la desactivación
      // por «maximum number of usage» pero no nombra el campo del insert →
      // `UseTimes` (API general de Dahua), VERIFY con el firmware en el smoke.
      ...(cred.maxUses != null ? { UseTimes: String(cred.maxUses) } : {}),
    });
    const res = await digestRequest({
      // `URLSearchParams` codifica el espacio como '+'; Dahua espera '%20'
      // (ejemplo literal de la doc: `ValidDateEnd=20151222%20093811`).
      url: `${this.base(device)}/cgi-bin/recordUpdater.cgi?${params.toString().replace(/\+/g, '%20')}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) this.logger.warn(`[dahua-sync] push ${device.hardwareId} → ${res.status}`);
    // El insert responde `RecNo=<n>`; el ref persistido sigue siendo el CardNo
    // (es lo que reportan los eventos de acceso y es estable entre re-syncs).
    return { ref: cardNo };
  }

  async setState(device: SyncDevice, ref: string, state: SyncState): Promise<void> {
    const c = this.creds(device);
    if (!c || !device.controlUrl) return;
    // El API general de Dahua actualiza por `recno` → se resuelve vía
    // recordFinder; si el firmware no lo devuelve, fallback por CardNo.
    const recno = await this.findRecno(device, c, ref);
    const params = new URLSearchParams({
      action: 'update',
      name: 'AccessControlCard',
      ...(recno ? { recno } : { CardNo: ref }),
      CardStatus: String(this.cardStatus(state)),
    });
    const res = await digestRequest({
      url: `${this.base(device)}/cgi-bin/recordUpdater.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) this.logger.warn(`[dahua-sync] setState ${device.hardwareId} → ${res.status}`);
  }

  async remove(device: SyncDevice, ref: string): Promise<void> {
    const c = this.creds(device);
    if (!c || !device.controlUrl) return;
    const recno = await this.findRecno(device, c, ref);
    const params = new URLSearchParams({
      action: 'remove',
      name: 'AccessControlCard',
      ...(recno ? { recno } : { CardNo: ref }),
    });
    const res = await digestRequest({
      url: `${this.base(device)}/cgi-bin/recordUpdater.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) this.logger.warn(`[dahua-sync] remove ${device.hardwareId} → ${res.status}`);
  }

  async pullEvents(device: SyncDevice, since: Date | null): Promise<SyncAccessEvent[]> {
    const c = this.creds(device);
    if (!c || !device.controlUrl) return [];
    const startTime = Math.floor((since?.getTime() ?? 0) / 1000);
    const endTime = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      action: 'find',
      name: 'AccessControlCardRec',
      StartTime: String(startTime),
      EndTime: String(endTime),
      count: '1024',
    });
    const res = await digestRequest({
      url: `${this.base(device)}/cgi-bin/recordFinder.cgi?${params}`,
      username: c.user,
      password: c.pass,
    });
    if (!res.ok) {
      this.logger.warn(`[dahua-sync] pullEvents ${device.hardwareId} → ${res.status}`);
      return [];
    }
    // Body confirmado (doc v1.0): records[i].RecNo/CreateTime (epoch s, UTC)/
    // CardNo/CardName/UserID/Type (Entry|Exit)/Status (0 fallo, 1 ok)/Method
    // (0 password, 1 tarjeta, 2-3 tarjeta+password, 6 huella, 15 cara)/Door…
    const events: SyncAccessEvent[] = [];
    for (const rec of DahuaSyncProvider.parseRecords(res.body)) {
      const createTime = Number(rec.CreateTime ?? 0);
      if (!Number.isFinite(createTime) || createTime <= 0) continue;
      const method = rec.Method === '0' ? 'pin' : 'rfid';
      events.push({
        occurredAt: new Date(createTime * 1000),
        credentialRef: rec.CardNo ?? null,
        method,
        // `Status` es opcional en el firmware: sin él se asume permitido.
        allowed: rec.Status !== '0',
        raw: {
          recNo: rec.RecNo,
          dahuaMethod: rec.Method,
          type: rec.Type,
          door: rec.Door,
          ...(rec.ErrorCode ? { errorCode: rec.ErrorCode } : {}),
        },
      });
    }
    return events;
  }
}
