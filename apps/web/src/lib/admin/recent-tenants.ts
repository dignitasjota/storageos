/** Últimos tenants abiertos en el panel admin (en este navegador). */
export interface RecentTenant {
  id: string;
  name: string;
}

const KEY = 'storageos.admin.recentTenants';
const MAX = 8;

export function readRecentTenants(): RecentTenant[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RecentTenant[]) : [];
  } catch {
    return [];
  }
}

export function rememberTenant(t: RecentTenant): void {
  try {
    const next = [t, ...readRecentTenants().filter((r) => r.id !== t.id)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* sin almacenamiento */
  }
}
