'use client';

import { SEO_STRATEGY_LABELS, type CreateSeoProjectInput } from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { BackLink } from '@/components/layout/back-link';
import { SeoAssistantPanel } from '@/components/seo/assistant/assistant-panel';
import { SeoBriefsCard } from '@/components/seo/assistant/briefs-card';
import { SeoAiProvider } from '@/components/seo/assistant/seo-ai-context';
import { SeoDiagnosticsCard } from '@/components/seo/diagnostics/diagnostics-card';
import { SeoMasterImportsCard } from '@/components/seo/master-imports-card';
import { SeoOpportunitiesCard } from '@/components/seo/opportunities/opportunities-card';
import { SeoPlanCard } from '@/components/seo/plan/plan-card';
import { SeoAlertsCard } from '@/components/seo/reports/alerts-card';
import { SeoConversionsCard } from '@/components/seo/reports/conversions-card';
import { SeoReportsCard } from '@/components/seo/reports/reports-card';
import { SeoDomainsCard } from '@/components/seo/seo-domains-card';
import { seoErrorMessage } from '@/components/seo/seo-errors';
import { SeoImportsCard } from '@/components/seo/seo-imports-card';
import { SeoPanel } from '@/components/seo/seo-panel';
import { SeoProjectDialog } from '@/components/seo/seo-project-dialog';
import { SeoProjectTabs } from '@/components/seo/seo-project-tabs';
import { SeoRunsCard } from '@/components/seo/seo-runs-card';
import { PlatformSistrixToggle } from '@/components/seo/sistrix/platform-sistrix-toggle';
import { SeoSistrixSections } from '@/components/seo/sistrix/sistrix-sections';
import { SeoCrawlCard } from '@/components/seo/technical/crawl-card';
import { SeoInspectionCard } from '@/components/seo/technical/inspection-card';
import { SeoPageSpeedCard } from '@/components/seo/technical/pagespeed-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useAddAdminSeoDomain,
  useAdminSeoProject,
  useAdminSeoProperties,
  useAdminSeoRuns,
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
import { useAdminSeoClient } from '@/lib/seo-advanced/panel';

/** Ficha de un proyecto de SEO: la plataforma la gestiona; la de un tenant, solo se ve. */
export default function AdminSeoProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const isSuperadmin = useIsSuperadmin();
  const project = useAdminSeoProject(id);
  const [editing, setEditing] = useState(false);
  // Solo el super admin importa, y solo en los proyectos de la plataforma.
  const client = useAdminSeoClient(id, isSuperadmin && project.data?.tenantId === null);
  const qc = useQueryClient();

  const active = hasActiveRun(project.data);
  const runs = useAdminSeoRuns(id, active);
  const properties = useAdminSeoProperties(true);
  const update = useUpdateAdminSeoProject(id);
  const remove = useDeleteAdminSeoProject();
  const addDomain = useAddAdminSeoDomain(id);
  const updateDomain = useUpdateAdminSeoDomain(id);
  const removeDomain = useRemoveAdminSeoDomain(id);
  const check = useCheckAdminSeoDomain(id);
  const sync = useSyncAdminSeoDomain(id);
  const cancel = useCancelAdminSeoRun();

  // Al terminar una descarga, el panel y el historial se ponen al día.
  const wasActive = useRef(active);
  const { refetch: refetchRuns } = runs;
  const { scope } = client;
  useEffect(() => {
    if (wasActive.current && !active) {
      void qc.invalidateQueries({ queryKey: scope });
      void refetchRuns();
    }
    wasActive.current = active;
  }, [active, qc, scope, refetchRuns]);

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

      {/* Preguntar: cualquier super admin; generar briefs y confirmar: superadmin en la plataforma. */}
      <SeoAiProvider
        value={{
          scope: { kind: 'admin', projectId: p.id },
          canGenerate: canEdit,
          canWrite: canEdit,
        }}
      >
        <SeoProjectTabs
          panels={{
            rendimiento: (
              <>
                <SeoPanel
                  client={client}
                  domains={p.domains}
                  planScope={{ kind: 'admin', projectId: p.id }}
                />
                <SeoConversionsCard
                  scope={{ kind: 'admin', projectId: p.id }}
                  canEdit={canEdit}
                  isPlatformProject={!isTenant}
                />
              </>
            ),
            palabras: (
              <SeoDiagnosticsCard
                scope={{ kind: 'admin', projectId: p.id }}
                canEdit={canEdit}
                domains={p.domains}
              />
            ),
            oportunidades: (
              <SeoOpportunitiesCard
                scope={{ kind: 'admin', projectId: p.id }}
                canEdit={canEdit}
                domains={p.domains}
              />
            ),
            competencia: (
              <>
                {isTenant && <PlatformSistrixToggle projectId={p.id} canEdit={isSuperadmin} />}
                <SeoSistrixSections scope={{ kind: 'admin', projectId: p.id }} canEdit={canEdit} />
              </>
            ),
            tecnico: (
              <>
                <SeoInspectionCard scope={{ kind: 'admin', projectId: p.id }} canEdit={canEdit} />
                <SeoPageSpeedCard scope={{ kind: 'admin', projectId: p.id }} canEdit={canEdit} />
                <SeoCrawlCard scope={{ kind: 'admin', projectId: p.id }} canEdit={canEdit} />
              </>
            ),
            plan: (
              <SeoPlanCard
                scope={{ kind: 'admin', projectId: p.id }}
                canEdit={canEdit}
                domains={p.domains}
              />
            ),
            informes: (
              <>
                <SeoAlertsCard scope={{ kind: 'admin', projectId: p.id }} canEdit={canEdit} />
                <SeoReportsCard scope={{ kind: 'admin', projectId: p.id }} canEdit={canEdit} />
              </>
            ),
            asistente: (
              <>
                <SeoAssistantPanel />
                <SeoBriefsCard />
              </>
            ),
            ajustes: (
              <>
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
                <SeoImportsCard client={client} domains={p.domains} />
                <SeoMasterImportsCard
                  scope={{ kind: 'admin', projectId: p.id }}
                  canEdit={canEdit}
                />
                <SeoRunsCard
                  runs={runs.data}
                  isLoading={runs.isLoading}
                  isError={runs.isError}
                  onRetry={() => void runs.refetch()}
                  canEdit={canEdit}
                  onCancel={(runId) => cancel.mutateAsync(runId)}
                />
              </>
            ),
          }}
        />
      </SeoAiProvider>

      <SeoProjectDialog
        open={editing}
        onOpenChange={setEditing}
        project={p}
        onSubmit={(input: CreateSeoProjectInput) => update.mutateAsync(input)}
      />
    </div>
  );
}
