'use client';

import { SEO_STRATEGY_LABELS, type CreateSeoProjectInput } from '@storageos/shared';
import { Loader2, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { BackLink } from '@/components/layout/back-link';
import { SeoDomainsCard } from '@/components/seo/seo-domains-card';
import { seoErrorMessage } from '@/components/seo/seo-errors';
import { SeoProjectDialog } from '@/components/seo/seo-project-dialog';
import { SeoRunsCard } from '@/components/seo/seo-runs-card';
import { SeoSummaryCard } from '@/components/seo/seo-summary-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useAddAdminSeoDomain,
  useAdminSeoProject,
  useAdminSeoProperties,
  useAdminSeoRuns,
  useAdminSeoSummary,
  useCancelAdminSeoRun,
  useCheckAdminSeoDomain,
  useDeleteAdminSeoProject,
  useRemoveAdminSeoDomain,
  useSyncAdminSeoDomain,
  useUpdateAdminSeoDomain,
  useUpdateAdminSeoProject,
} from '@/lib/admin/seo-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { hasActiveRun } from '@/lib/seo-advanced/hooks';

/** Ficha de un proyecto de SEO: la plataforma la gestiona; la de un tenant, solo se ve. */
export default function AdminSeoProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const isSuperadmin = useIsSuperadmin();
  const project = useAdminSeoProject(id);
  const [days, setDays] = useState(28);
  const [domainId, setDomainId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const active = hasActiveRun(project.data);
  const runs = useAdminSeoRuns(id, active);
  const summary = useAdminSeoSummary(id, days, domainId);
  const properties = useAdminSeoProperties(true);
  const update = useUpdateAdminSeoProject(id);
  const remove = useDeleteAdminSeoProject();
  const addDomain = useAddAdminSeoDomain(id);
  const updateDomain = useUpdateAdminSeoDomain(id);
  const removeDomain = useRemoveAdminSeoDomain(id);
  const check = useCheckAdminSeoDomain(id);
  const sync = useSyncAdminSeoDomain(id);
  const cancel = useCancelAdminSeoRun();

  // Al terminar una descarga, el resumen y el historial se ponen al día.
  const wasActive = useRef(active);
  const { refetch: refetchSummary } = summary;
  const { refetch: refetchRuns } = runs;
  useEffect(() => {
    if (wasActive.current && !active) {
      void refetchSummary();
      void refetchRuns();
    }
    wasActive.current = active;
  }, [active, refetchSummary, refetchRuns]);

  if (project.isError) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6">
        <AdminError onRetry={() => void project.refetch()} />
      </div>
    );
  }
  if (project.isLoading || !project.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const p = project.data;
  const isTenant = p.tenantId !== null;
  const canEdit = isSuperadmin && !isTenant;

  const toggle = async () => {
    try {
      await update.mutateAsync({ status: p.status === 'active' ? 'paused' : 'active' });
      toast.success(p.status === 'active' ? 'Proyecto en pausa' : 'Proyecto activo');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const del = async () => {
    const yes = await confirm({
      title: `¿Borrar ${p.name}?`,
      description: 'Se borran sus dominios y todo lo descargado de Google. No se puede deshacer.',
      confirmLabel: 'Borrar proyecto',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(p.id);
      toast.success('Proyecto borrado');
      router.push('/admin/seo');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="space-y-2">
        <BackLink href="/admin/seo" label="Proyectos" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h1 className="break-words text-2xl font-semibold tracking-tight">{p.name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{SEO_STRATEGY_LABELS[p.strategy]}</span>
              {p.targetLocation && <span>· {p.targetLocation}</span>}
              {p.status === 'paused' && <Badge variant="outline">En pausa</Badge>}
              {isTenant && (
                <Badge variant="secondary">
                  Proyecto de {p.tenantName ?? 'un tenant'} · solo lectura
                </Badge>
              )}
            </div>
          </div>
          {canEdit && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="mr-1 size-4" aria-hidden /> Editar
              </Button>
              <Button variant="outline" size="sm" onClick={() => void toggle()}>
                {p.status === 'active' ? (
                  <>
                    <Pause className="mr-1 size-4" aria-hidden /> Pausar
                  </>
                ) : (
                  <>
                    <Play className="mr-1 size-4" aria-hidden /> Activar
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Borrar proyecto"
                title="Borrar proyecto"
                onClick={() => void del()}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          )}
        </div>
      </div>

      <SeoSummaryCard
        summary={summary.data}
        isLoading={summary.isLoading}
        isError={summary.isError}
        onRetry={() => void summary.refetch()}
        days={days}
        onDaysChange={setDays}
        domains={p.domains}
        domainId={domainId}
        onDomainChange={setDomainId}
      />

      <SeoDomainsCard
        project={p}
        serviceAccountEmail={properties.data?.serviceAccountEmail ?? null}
        canEdit={canEdit}
        actions={{
          add: (input) => addDomain.mutateAsync(input),
          check: (domain) => check.mutateAsync(domain),
          sync: (domain) => sync.mutateAsync(domain),
          remove: (domain) => removeDomain.mutateAsync(domain),
          setRole: (domain, role) => updateDomain.mutateAsync({ id: domain, role }),
        }}
      />

      <SeoRunsCard
        runs={runs.data}
        isLoading={runs.isLoading}
        isError={runs.isError}
        onRetry={() => void runs.refetch()}
        canEdit={canEdit}
        onCancel={(runId) => cancel.mutateAsync(runId)}
      />

      <SeoProjectDialog
        open={editing}
        onOpenChange={setEditing}
        project={p}
        onSubmit={(input: CreateSeoProjectInput) => update.mutateAsync(input)}
      />
    </div>
  );
}
