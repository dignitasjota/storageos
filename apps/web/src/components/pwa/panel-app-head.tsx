'use client';

import { TenantAppHead } from './tenant-app-head';

import { usePanelBrand } from '@/lib/auth/hooks';
import { iconVersion, panelManifestPath } from '@/lib/portal/tenant-app';

/**
 * Con «Panel con tu marca» (plan Pro), el panel del equipo se instala con el
 * nombre y el icono del tenant en vez de los de TrasterOS.
 */
export function PanelAppHead() {
  const brand = usePanelBrand();
  if (!brand) return null;
  return (
    <TenantAppHead
      slug={brand.slug}
      tenantName={brand.name}
      iconVersion={iconVersion(brand)}
      manifestPath={panelManifestPath(brand.slug)}
    />
  );
}
