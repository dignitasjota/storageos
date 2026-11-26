'use client';

import { SEO_STRATEGY_LABELS, SEO_TENANT_LIMITS } from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
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
import { SeoRunsCard } from '@/components/seo/seo-runs-card';
import { SeoSistrixSections } from '@/components/seo/sistrix/sistrix-sections';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  hasActiveRun,
  useAddSeoDomain,
  useCancelSeoRun,
  useCheckSeoDomain,
  useCreateSeoProject,
  useRemoveSeoDomain,
  useSeoRuns,
  useSeoWorkspace,
  useSyncSeoDomain,
  useUpdateSeoDomain,
  useUpdateSeoProject,
} from '@/lib/seo-advanced/hooks';
import { useTenantSeoClient } from '@/lib/seo-advanced/panel';

/** Análisis → SEO Avanzado: el proyecto de la web del negocio. */
export default function SeoAdvancedPage() {
  const canEdit = useHasPermission('settings:manage');
  const workspace = useSeoWorkspace();
  const project = workspace.data?.project ?? null;
  const active = hasActiveRun(project);
  const [editing, setEditing] = useState(false);
  const client = useTenantSeoClient(canEdit);
  const qc = useQueryClient();

  const runs = useSeoRuns(!!project, active);
  const create = useCreateSeoProject();
  const update = useUpdateSeoProject();
  const addDomain = useAddSeoDomain();
  const updateDomain = useUpdateSeoDomain();
  const removeDomain = useRemoveSeoDomain();
  const check = useCheckSeoDomain();
  const sync = useSyncSeoDomain();
  const cancel = useCancelSeoRun();

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

  const start = async () => {
    try {
      await create.mutateAsync({});
      toast.success('Proyecto creado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">SEO Avanzado</h1>
        <p className="text-sm text-muted-foreground">
          Lo que dice Google de tu web, con el detalle de búsquedas, páginas, países y dispositivos,
          día a día.
        </p>
      </div>
      {project && canEdit && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing(true)}>
          <Pencil className="mr-1 size-4" aria-hidden /> Datos del proyecto
        </Button>
      )}
    </div>
  );

  if (workspace.isError) {
    return (
      <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
        {header}
        <SectionError onRetry={() => void workspace.refetch()} />
      </div>
    );
  }
  if (workspace.isLoading || !workspace.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
        {header}
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Search className="size-6" aria-hidden />
            </span>
            <div className="max-w-md space-y-1">
              <p className="font-medium">Empieza con tu web</p>
              <p className="text-sm text-muted-foreground">
                Crearemos el proyecto con tu web
                {workspace.data.suggestedProperty ? (
                  <>
                    {' '}
                    (<span className="break-all font-mono">{workspace.data.suggestedProperty}</span>
                    )
                  </>
                ) : null}{' '}
                como dominio principal. Después podrás añadir hasta{' '}
                {SEO_TENANT_LIMITS.secondaryDomains} dominios más.
              </p>
            </div>
            {canEdit ? (
              <Button onClick={() => void start()} disabled={create.isPending}>
                {create.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
                Crear el proyecto
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Pídeselo a quien gestiona la configuración de tu negocio.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const secondaries = project.domains.filter((d) => d.role !== 'primary').length;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      {header}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{project.name}</span>
        <span>· {SEO_STRATEGY_LABELS[project.strategy]}</span>
        {project.targetLocation && <span>· {project.targetLocation}</span>}
        {project.status === 'paused' && <Badge variant="outline">En pausa</Badge>}
      </div>

      <SeoPanel client={client} domains={project.domains} planScope={{ kind: 'tenant' }} />

      <SeoConversionsCard scope={{ kind: 'tenant' }} canEdit={canEdit} />

      <SeoAlertsCard scope={{ kind: 'tenant' }} canEdit={canEdit} />

      <SeoOpportunitiesCard
        scope={{ kind: 'tenant' }}
        canEdit={canEdit}
        domains={project.domains}
      />

      <SeoDiagnosticsCard scope={{ kind: 'tenant' }} canEdit={canEdit} domains={project.domains} />

      <SeoPlanCard scope={{ kind: 'tenant' }} canEdit={canEdit} domains={project.domains} />

      <SeoReportsCard scope={{ kind: 'tenant' }} canEdit={canEdit} />

      <SeoDomainsCard
        project={project}
        serviceAccountEmail={workspace.data.serviceAccountEmail}
        canEdit={canEdit}
        suggestedProperty={workspace.data.suggestedProperty}
        limitText={`Puedes tener un dominio principal y ${SEO_TENANT_LIMITS.secondaryDomains} más (llevas ${secondaries}). El principal tiene que ser de tu negocio: tu dominio propio, el de tu correo verificado o tu dirección en TrasterOS. Otra web tuya puede ir como secundaria si nuestra cuenta tiene acceso a ella en Search Console y no la usa otra cuenta.`}
        actions={{
          add: (input) => addDomain.mutateAsync(input),
          check: (id) => check.mutateAsync(id),
          sync: (id) => sync.mutateAsync(id),
          remove: (id) => removeDomain.mutateAsync(id),
          setRole: (id, role) => updateDomain.mutateAsync({ id, role }),
        }}
      />

      <SeoImportsCard client={client} domains={project.domains} />

      <SeoMasterImportsCard scope={{ kind: 'tenant' }} canEdit={canEdit} />

      <SeoRunsCard
        runs={runs.data}
        isLoading={runs.isLoading}
        isError={runs.isError}
        onRetry={() => void runs.refetch()}
        canEdit={canEdit}
        onCancel={(id) => cancel.mutateAsync(id)}
      />

      <SeoSistrixSections scope={{ kind: 'tenant' }} canEdit={canEdit} />

      <SeoProjectDialog
        open={editing}
        onOpenChange={setEditing}
        project={project}
        onSubmit={(input) => update.mutateAsync(input)}
      />
    </div>
  );
}
