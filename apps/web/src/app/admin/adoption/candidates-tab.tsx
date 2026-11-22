'use client';

import { Loader2, Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { TenantsBulkBar } from '../tenants/tenants-bulk-bar';

import type { AdminUpgradeCandidateDto, AdminUpgradeSuggestionDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import {
  EMPTY_LIST_FILTERS,
  ListControls,
  type ListFilters,
  matchesListFilters,
  nextSort,
  SortButton,
  sortRows,
  type SortState,
} from '@/components/admin/health/list-controls';
import { TenantRowActions } from '@/components/admin/health/tenant-row-actions';
import { ProposeAddonDialog } from '@/components/admin/propose-addon-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { useUpgradeCandidates } from '@/lib/admin/health-insights-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { useLoadMore } from '@/lib/admin/use-load-more';
import { downloadCsv } from '@/lib/csv';
import { formatEur, plural } from '@/lib/format';

const REASON_LABELS: Record<string, string> = {
  taps_limit: 'Topa un límite',
  near_limit: 'Cerca del límite',
  outside_plan: 'Usa fuera de su plan',
  interest: 'Interés',
};

type SortKey = 'estimated' | 'paid' | 'name';

/**
 * Candidatos a vender: cerca o en el límite, usan funciones fuera de su plan o
 * han entrado varias veces en una función que no tienen. Con el ingreso extra
 * estimado y «Proponer» (el extra con su correo, o la cuota en el simulador).
 */
export function CandidatesTab() {
  const q = useUpgradeCandidates();
  const isSuperadmin = useIsSuperadmin();
  const [filters, setFilters] = useState<ListFilters>({
    ...EMPTY_LIST_FILTERS,
    reason: '',
    sortKey: 'estimated',
    sortDir: 'desc',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [proposal, setProposal] = useState<{
    candidate: AdminUpgradeCandidateDto;
    suggestion: AdminUpgradeSuggestionDto;
  } | null>(null);

  const all = useMemo(() => q.data?.candidates ?? [], [q.data]);
  const sort: SortState<SortKey> = {
    key: (filters.sortKey as SortKey) || 'estimated',
    dir: filters.sortDir === 'asc' ? 1 : -1,
  };
  const onSort = (k: SortKey) => {
    const n = nextSort(sort, k, ['name']);
    setFilters({ ...filters, sortKey: n.key, sortDir: n.dir === 1 ? 'asc' : 'desc' });
  };
  const rows = useMemo(() => {
    const reason = String(filters.reason ?? '');
    const list = all
      .filter((c) => matchesListFilters(c, filters))
      .filter((c) => !reason || c.reasons.some((r) => r.kind === reason));
    return sortRows(list, sort, (c, k) =>
      k === 'name' ? c.name : k === 'paid' ? c.monthlyPaid : c.estimatedExtraMonthly,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filters]);
  const page = useLoadMore(rows, 25, JSON.stringify(filters));
  useEffect(() => setSelected(new Set()), [filters]);

  function exportCsv(list: AdminUpgradeCandidateDto[], name = 'candidatos.csv') {
    downloadCsv(name, [
      [
        'Tenant',
        'Identificador',
        'Plan',
        'Comercial',
        'Paga al mes sin IVA (EUR)',
        'Motivos',
        'Propuesta',
        'Ingreso extra estimado al mes sin IVA (EUR)',
        'Última propuesta',
      ],
      ...list.map((c) => [
        c.name,
        c.slug,
        c.planName ?? '',
        c.salesRepName ?? '',
        c.monthlyPaid,
        c.reasons.map((r) => r.detail).join(' · '),
        c.suggestions.map((s) => s.name).join(' · '),
        c.estimatedExtraMonthly,
        c.lastOfferAt ? new Date(c.lastOfferAt).toLocaleDateString('es-ES') : '',
      ]),
    ]);
  }

  if (q.isError) return <AdminError onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const allVisibleSelected =
    page.visible.length > 0 && page.visible.every((c) => selected.has(c.tenantId));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card px-4 py-3 text-sm">
        <span className="font-medium">
          {plural(all.length, 'candidato', 'candidatos')} · ingreso extra estimado{' '}
          {formatEur(q.data.totalEstimatedMonthly)}/mes
        </span>{' '}
        <span className="text-muted-foreground">
          sin IVA, si todos aceptaran la mejor propuesta. Interés = su equipo entró 2 veces o más en
          30 días en una función que no tiene.
        </span>
      </div>

      <TenantsBulkBar
        selected={[...selected]}
        trialCount={all.filter((c) => selected.has(c.tenantId) && c.status === 'trial').length}
        showTrial={false}
        onClear={() => setSelected(new Set())}
        onExport={() =>
          exportCsv(
            all.filter((c) => selected.has(c.tenantId)),
            'candidatos-seleccion.csv',
          )
        }
      />

      <Card className="min-w-0">
        <CardHeader className="space-y-3">
          <CardTitle className="text-base">
            {plural(rows.length, 'candidato', 'candidatos')}
          </CardTitle>
          <ListControls page="adoption" rows={all} filters={filters} onChange={setFilters}>
            {Object.entries(REASON_LABELS).map(([k, label]) => (
              <Button
                key={k}
                size="sm"
                variant={filters.reason === k ? 'default' : 'outline'}
                onClick={() => setFilters({ ...filters, reason: filters.reason === k ? '' : k })}
              >
                {label}
              </Button>
            ))}
          </ListControls>
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Checkbox
              aria-label="Seleccionar los visibles"
              checked={allVisibleSelected ? true : selected.size > 0 ? 'indeterminate' : false}
              onCheckedChange={() =>
                setSelected(
                  allVisibleSelected ? new Set() : new Set(page.visible.map((c) => c.tenantId)),
                )
              }
              className="mr-2"
            />
            Ordenar por:
            <SortButton label="Ingreso extra" k="estimated" sort={sort} onSort={onSort} />
            <SortButton label="Lo que paga" k="paid" sort={sort} onSort={onSort} />
            <SortButton label="Nombre" k="name" sort={sort} onSort={onSort} />
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7"
              onClick={() => exportCsv(rows)}
              disabled={rows.length === 0}
            >
              Exportar CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Sin candidatos para este filtro.</p>
          ) : (
            <>
              <ul className="divide-y">
                {page.visible.map((c) => (
                  <li
                    key={c.tenantId}
                    className={`flex flex-wrap items-start gap-3 py-3 ${selected.has(c.tenantId) ? 'bg-primary/5' : ''}`}
                  >
                    <Checkbox
                      aria-label={`Seleccionar ${c.name}`}
                      checked={selected.has(c.tenantId)}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.tenantId)) next.delete(c.tenantId);
                          else next.add(c.tenantId);
                          return next;
                        })
                      }
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1 basis-60">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link
                          href={`/admin/tenants/${c.tenantId}?tab=business`}
                          className="min-w-0 break-words font-medium hover:underline"
                        >
                          {c.name}
                        </Link>
                        <Badge variant="outline">{c.planName ?? 'sin plan'}</Badge>
                        {c.estimatedExtraMonthly > 0 && (
                          <Badge className="border-0 bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">
                            +{formatEur(c.estimatedExtraMonthly)}/mes
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          paga {formatEur(c.monthlyPaid)}/mes
                          {c.salesRepName ? ` · ${c.salesRepName}` : ''}
                          {c.lastOfferAt
                            ? ` · última propuesta el ${new Date(c.lastOfferAt).toLocaleDateString('es-ES')}`
                            : ''}
                        </span>
                      </div>
                      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {c.reasons.map((r, i) => (
                          <li key={i}>
                            <span className="font-medium text-foreground">
                              {REASON_LABELS[r.kind]}:
                            </span>{' '}
                            {r.detail.replace(/^(Topa|Cerca del límite|Usa sin tenerlo): /, '')}
                          </li>
                        ))}
                      </ul>
                      {c.suggestions.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {c.suggestions.map((s) => (
                            <SuggestionButton
                              key={`${s.type}-${s.id}`}
                              c={c}
                              s={s}
                              canPropose={isSuperadmin}
                              onPropose={() => setProposal({ candidate: c, suggestion: s })}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                    <TenantRowActions
                      tenantId={c.tenantId}
                      tenantName={c.name}
                      defaultFollowupTitle="Proponerle subir de plan o un extra"
                    />
                  </li>
                ))}
              </ul>
              {page.hasMore && (
                <div className="pt-3 text-center">
                  <Button variant="outline" size="sm" onClick={page.loadMore}>
                    Cargar más ({plural(page.remaining, 'queda', 'quedan')})
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {proposal && (
        <ProposeAddonDialog
          tenantId={proposal.candidate.tenantId}
          tenantName={proposal.candidate.name}
          addon={{
            id: proposal.suggestion.id,
            name: proposal.suggestion.name,
            priceMonthly: proposal.suggestion.extraMonthly,
          }}
          canTrial={proposal.suggestion.trialable}
          open
          onOpenChange={(v) => !v && setProposal(null)}
        />
      )}
    </div>
  );
}

function SuggestionButton({
  c,
  s,
  canPropose,
  onPropose,
}: {
  c: AdminUpgradeCandidateDto;
  s: AdminUpgradeSuggestionDto;
  canPropose: boolean;
  onPropose: () => void;
}) {
  const label = `${s.type === 'plan' ? 'Plan' : 'Extra'} ${s.name} (+${formatEur(s.extraMonthly)}/mes)`;
  if (s.type === 'plan') {
    return (
      <Button asChild size="sm" variant="outline" className="h-8">
        <Link href={`/admin/quote?tenantId=${c.tenantId}&plan=${s.slug ?? ''}`}>
          <Send className="mr-1.5 size-3.5" /> Proponer: {label}
        </Link>
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8"
      onClick={onPropose}
      disabled={!canPropose}
      title={canPropose ? undefined : 'Solo el rol superadmin envía propuestas'}
    >
      <Send className="mr-1.5 size-3.5" /> Proponer: {label}
    </Button>
  );
}
