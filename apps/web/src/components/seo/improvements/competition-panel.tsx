'use client';

import { SEO_NO_GROUP, type SeoCompetitionMoverDto } from '@storageos/shared';
import { ArrowDown, ArrowUp, Swords } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDate, formatNumber } from '@/lib/format';
import {
  useCompetitionEvolution,
  useCompetitionGroups,
  useCompetitionMovers,
  type ImprovementScope,
} from '@/lib/seo-advanced/improvement-hooks';
import { useSistrixKeywords } from '@/lib/seo-advanced/sistrix-hooks';
import { cn } from '@/lib/utils';

const CURRENT = 'var(--seo-current)';
const PREVIOUS = 'var(--seo-previous)';

function Move({ m }: { m: SeoCompetitionMoverDto }) {
  if (m.previous === null)
    return (
      <span className="text-xs text-sky-700 dark:text-sky-400">Entra en el puesto {m.current}</span>
    );
  if (m.current === null)
    return <span className="text-xs text-muted-foreground">Sale (estaba en el {m.previous})</span>;
  const up = (m.diff ?? 0) > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs',
        up ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
      )}
    >
      {up ? (
        <ArrowUp className="size-3" aria-hidden />
      ) : (
        <ArrowDown className="size-3" aria-hidden />
      )}
      {Math.abs(m.diff ?? 0)} (del {m.previous} al {m.current})
    </span>
  );
}

function Movers({ scope }: { scope: ImprovementScope }) {
  const data = useCompetitionMovers(scope);
  const d = data.data;
  const [who, setWho] = useState('all');
  if (data.isError) return <SectionError onRetry={() => void data.refetch()} />;
  if (!d) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  if (d.from === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Hacen falta al menos dos muestras de Google de tus palabras para ver quién sube y quién baja
        {d.withoutHistory > 0 ? ` (${d.withoutHistory} palabras aún con una sola)` : ''}. Se toman
        con SISTRIX cada cierto tiempo, o importando un CSV.
      </p>
    );
  }
  const items = d.items.filter((i) => who === 'all' || i.domain === who);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Entre las muestras del {formatDate(d.from)} y del {formatDate(d.to ?? d.from)}.
        {d.withoutHistory > 0
          ? ` ${d.withoutHistory} palabras sin dos muestras no se comparan.`
          : ''}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setWho('all')}
          aria-pressed={who === 'all'}
          className={cn(
            'rounded-full border px-2.5 py-1 text-xs',
            who === 'all' ? 'border-primary bg-primary/10' : 'hover:bg-muted',
          )}
        >
          Todos
        </button>
        {d.summary.map((s) => (
          <button
            key={s.domain}
            type="button"
            onClick={() => setWho(s.domain)}
            aria-pressed={who === s.domain}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs',
              who === s.domain ? 'border-primary bg-primary/10' : 'hover:bg-muted',
            )}
          >
            {s.domain}
            {s.own ? ' (tú)' : ''} ·{' '}
            <span className="text-emerald-700 dark:text-emerald-400">▲{s.up}</span>{' '}
            <span className="text-red-700 dark:text-red-400">▼{s.down}</span>
            {s.entered > 0 ? ` · +${s.entered}` : ''}
            {s.left > 0 ? ` · −${s.left}` : ''}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nadie se ha movido en estas palabras.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((m) => (
            <li key={`${m.domain}|${m.keyword}`} className="space-y-0.5 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{m.keyword}</span>
                <Move m={m} />
              </div>
              <p className="text-xs text-muted-foreground">
                {m.domain}
                {m.own ? ' (tú)' : ''}
                {m.group ? ` · ${m.group}` : ''}
                {m.title ? ` · «${m.title}»` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Groups({ scope }: { scope: ImprovementScope }) {
  const data = useCompetitionGroups(scope);
  const d = data.data;
  if (data.isError) return <SectionError onRetry={() => void data.refetch()} />;
  if (!d) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  if (d.groups.length === 0) {
    return <p className="text-sm text-muted-foreground">Aún no sigues ninguna palabra.</p>;
  }
  const domains = d.groups[0]?.cells ?? [];
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Grupo de palabras</th>
            {domains.map((c) => (
              <th key={c.domain} className="px-3 py-2 text-right font-medium">
                {c.domain}
                {c.own ? ' (tú)' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {d.groups.map((g) => (
            <tr key={g.group ?? SEO_NO_GROUP}>
              <td className="px-3 py-2">
                {g.group ?? 'Sin grupo'}
                <span className="block text-xs text-muted-foreground">
                  {g.sampled} de {g.keywords} con muestra de Google
                </span>
              </td>
              {g.cells.map((c) => (
                <td key={c.domain} className="px-3 py-2 text-right tabular-nums">
                  {c.averagePosition === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      {formatNumber(c.averagePosition, 1)}
                      <span className="block text-xs text-muted-foreground">
                        sale en {c.appears} · mejor {c.best}
                      </span>
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Evolution({ scope }: { scope: ImprovementScope }) {
  const keywords = useSistrixKeywords(scope);
  const groups = useCompetitionGroups(scope);
  const [keywordId, setKeywordId] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const domains = groups.data?.groups[0]?.cells ?? [];
  const evo = useCompetitionEvolution(scope, domain, keywordId);
  const chart = useMemo(
    () =>
      (evo.data?.points ?? []).map((p, i) => ({
        date: p.date,
        rival: p.position,
        mine: evo.data?.mine[i]?.position ?? null,
      })),
    [evo.data],
  );
  const rows = keywords.data ?? [];
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={keywordId ?? ''} onValueChange={setKeywordId}>
          <SelectTrigger aria-label="Palabra">
            <SelectValue placeholder="Elige una palabra" />
          </SelectTrigger>
          <SelectContent>
            {rows.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.keyword}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={domain ?? ''} onValueChange={setDomain}>
          <SelectTrigger aria-label="Competidor">
            <SelectValue placeholder="Elige un competidor" />
          </SelectTrigger>
          <SelectContent>
            {domains
              .filter((c) => !c.own)
              .map((c) => (
                <SelectItem key={c.domain} value={c.domain}>
                  {c.domain}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      {!keywordId || !domain ? (
        <p className="text-sm text-muted-foreground">
          Elige una palabra y un competidor para ver cómo ha ido su posición frente a la tuya.
        </p>
      ) : evo.isError ? (
        <SectionError onRetry={() => void evo.refetch()} />
      ) : chart.length === 0 || chart.every((c) => c.rival === null && c.mine === null) ? (
        <p className="text-sm text-muted-foreground">
          Ninguno de los dos sale en las muestras guardadas.
        </p>
      ) : (
        <div
          className="h-64 w-full"
          role="img"
          aria-label={`Evolución de ${domain} y de tu web en «${evo.data?.keyword}»`}
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 600, height: 256 }}
          >
            <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tickFormatter={(v: string) => formatDate(v)} fontSize={11} />
              <YAxis
                reversed
                domain={[1, 'dataMax + 2']}
                allowDecimals={false}
                fontSize={11}
                width={32}
              />
              <Tooltip
                formatter={(v: unknown) => (typeof v === 'number' ? `Puesto ${v}` : 'No sale')}
                labelFormatter={(l: unknown) => formatDate(String(l))}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="mine"
                name="Tú"
                stroke={CURRENT}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="rival"
                name={domain}
                stroke={PREVIOUS}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {evo.data && evo.data.points.some((p) => p.title) && (
        <p className="text-xs text-muted-foreground">
          Último título que enseña {domain}: «
          {[...evo.data.points].reverse().find((p) => p.title)?.title}»
        </p>
      )}
    </div>
  );
}

/**
 * La competencia con lo que ya se guarda de Google (mejora 4): quién sube y
 * quién baja entre las dos últimas muestras, comparativa por grupo de palabras
 * y evolución de un competidor en una palabra.
 */
export function SeoCompetitionPanel({ scope }: { scope: ImprovementScope }) {
  const [tab, setTab] = useState<'movers' | 'groups' | 'evolution'>('movers');
  const tabs = [
    { id: 'movers', label: 'Esta semana' },
    { id: 'groups', label: 'Por grupo de palabras' },
    { id: 'evolution', label: 'Evolución' },
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Swords className="size-4" aria-hidden /> Cómo se mueve la competencia
          <Badge variant="outline" className="font-normal">
            Resultados de Google guardados
          </Badge>
        </CardTitle>
        <CardDescription>
          Quién sube y quién baja en tus palabras, cómo te comparas con cada competidor por grupo de
          palabras y cómo ha evolucionado uno en una palabra concreta. Un competidor de un
          directorio solo cuenta lo que cuelga de su ruta.
        </CardDescription>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Vista de la competencia">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                tab === t.id ? 'border-primary bg-primary/10' : 'hover:bg-muted',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {tab === 'movers' ? (
          <Movers scope={scope} />
        ) : tab === 'groups' ? (
          <Groups scope={scope} />
        ) : (
          <Evolution scope={scope} />
        )}
      </CardContent>
    </Card>
  );
}
