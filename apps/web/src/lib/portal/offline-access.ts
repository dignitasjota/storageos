import { QRCodeSVG } from 'qrcode.react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PortalAccessCredentialDto } from '@storageos/shared';

/**
 * Copia del acceso del inquilino en su móvil para enseñarlo sin conexión: en
 * el local a veces no hay cobertura. La lee `public/offline.html`, que es lo
 * que sirve el service worker cuando no hay red. Mismo almacenamiento que la
 * sesión del portal (quien tiene el móvil ya tenía acceso a estos códigos).
 */
export const OFFLINE_ACCESS_KEY = 'storageos.portal.offline-access';

export interface OfflineAccessItem {
  label: string | null;
  method: 'pin' | 'qr';
  value: string;
  /** QR ya dibujado (SVG), para no necesitar ninguna librería sin conexión. */
  qrSvg: string | null;
  expiresAt: string | null;
}

export interface OfflineAccess {
  tenantName: string;
  locale: string;
  savedAt: string;
  items: OfflineAccessItem[];
}

/** Guarda los accesos activos con código; sin ninguno, borra la copia. */
export function saveOfflineAccess(
  tenantName: string,
  locale: string,
  credentials: PortalAccessCredentialDto[],
): void {
  try {
    const items: OfflineAccessItem[] = credentials
      .filter((c) => c.value && c.status === 'active' && !c.suspension)
      .map((c) => ({
        label: c.label,
        method: c.method,
        value: c.value!,
        qrSvg:
          c.method === 'qr'
            ? renderToStaticMarkup(
                createElement(QRCodeSVG, { value: c.value!, size: 240, marginSize: 2 }),
              )
            : null,
        expiresAt: c.expiresAt,
      }));
    if (items.length === 0) {
      localStorage.removeItem(OFFLINE_ACCESS_KEY);
      return;
    }
    const data: OfflineAccess = {
      tenantName,
      locale,
      savedAt: new Date().toISOString(),
      items,
    };
    localStorage.setItem(OFFLINE_ACCESS_KEY, JSON.stringify(data));
  } catch {
    /* sin almacenamiento: no se guarda */
  }
}

export function clearOfflineAccess(): void {
  try {
    localStorage.removeItem(OFFLINE_ACCESS_KEY);
  } catch {
    /* ignore */
  }
}
