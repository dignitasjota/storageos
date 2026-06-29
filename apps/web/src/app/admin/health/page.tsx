'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { AdminTenantHealthDto, AdminTenantHealthLevel } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAdminTenantsHealth } from '@/lib/admin/hooks';

const LEVELS: {
  key: AdminTenantHealthLevel;
  label: string;
  badge: string;
  bar: string;
}[] = [
  { key: 'healthy', label: 'Saludable', badge: 'bg-green-100 text-green-700', bar: 'bg-green-500' },
  { key: 'warm', label: 'Tibio', badge: 'bg-sky-100 text-sky-700', bar: 'bg-sky-500' },
  { key: 'at_risk', label: 'En riesgo', badge: 'bg-amber-100 text-amber-700', bar: 'bg-amber-500' },
  { key: 'dormant', label: 'Dormido', badge: 'bg-red-100 text-red-700', bar: 'bg-red-500' },
];

const LEVEL_BY_KEY = new Map(LEVELS.map((l) => [l.key, l]));

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-ES') : 'nunca';
}

export default function AdminHealthPage() {
  const health = useAdminTenantsHealth();
  const [levelFilter, setLevelFilter] = useState<AdminTenantHealthLevel | null>(null);
  const [q, setQ] = useState('');

  const all = useMemo(() => health.data ?? [], [health.data]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of all) m[t.level] = (m[t.level] ?? 0) + 1;
    return m;
  }, [all]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((t) => !levelFilter || t.level === levelFilter)
      .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.slug.includes(needle));
  }, [all, levelFilter, q]);

  if (health.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Salud de tenants</h1>
        <p className="text-sm text-muted-foreground">
          Score 0-100 por tenant (actividad del equipo, facturación, suscripción y adopción).
          Ordenados de más urgente a más sano.
        </p>
      </div>

      {/* Resumen por nivel (clicable para filtrar). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {LEVELS.map((l) => {
          const active = levelFilter === l.key;
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => setLevelFilter(active ? null : l.key)}
              className={`rounded-lg border px-4 py-3 text-left transition ${
                active ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/50'
              }`}
            >
              <div className="text-2xl font-bold">{counts[l.key] ?? 0}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={`inline-block size-2 rounded-full ${l.bar}`} />
                {l.label}
              </div>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">
            {levelFilter ? LEVEL_BY_KEY.get(levelFilter)?.label : 'Todos'} · {items.length}
          </CardTitle>
          <Input
            placeholder="Buscar tenant…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Sin tenants para este filtro.</p>
          ) : (
            <ul className="divide-y">
              {items.map((t) => (
                <HealthRow key={t.tenantId} t={t} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HealthRow({ t }: { t: AdminTenantHealthDto }) {
  const level = LEVEL_BY_KEY.get(t.level);
  return (
    <li className="flex flex-wrap items-center gap-4 py-3">
      {/* Score + barra. */}
      <div className="w-24 shrink-0">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tabular-nums">{t.score}</span>
          <span className="text-xs text-muted-foreground">/100</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${level?.bar}`} style={{ width: `${t.score}%` }} />
        </div>
      </div>

      {/* Identidad + factores. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{t.name}</span>
          <span className="text-xs text-muted-foreground">/{t.slug}</span>
          <Badge className={`${level?.badge} border-0`}>{level?.label}</Badge>
          {t.planName && <span className="text-xs text-muted-foreground">· {t.planName}</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {t.factors.map((f) => (
            <span key={f.key}>
              <span className="font-medium tabular-nums">{f.score}</span> {f.label.toLowerCase()}
            </span>
          ))}
          <span>· últ. acceso {fmtDate(t.lastActivityAt)}</span>
        </div>
      </div>

      <Button asChild variant="outline" size="sm">
        <Link href={`/admin/tenants/${t.tenantId}`}>Ver tenant</Link>
      </Button>
    </li>
  );
}
