'use client';

import { Loader2 } from 'lucide-react';

import { SeoAiVisibilityPanel } from './ai-visibility-panel';
import { CompetitorsPanel } from './competitors-panel';
import { KeywordIdeasPanel } from './keyword-ideas-panel';
import { BacklinksPanel } from './links-ai-panels';
import { SistrixStatus } from './sistrix-status';
import { TenantSistrixCard } from './tenant-sistrix-card';

import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  type SistrixScope,
  useCancelSistrixRun,
  useSistrixSync,
  useSistrixWorkspace,
} from '@/lib/seo-advanced/sistrix-hooks';

/**
 * SISTRIX en un proyecto: competidores, ideas de palabras, enlaces y
 * visibilidad en IA (sus oportunidades van en la lista de Oportunidades y las
 * palabras seguidas, con sus métricas de SISTRIX, en el diagnóstico). Lo usan la ficha del proyecto del panel admin y la
 * página de SEO Avanzado del tenant. Cada dato lleva su origen y su fecha.
 */
export function SeoSistrixSections({
  scope,
  canEdit,
  canConfigure = canEdit,
}: {
  scope: SistrixScope;
  /** Puede gestionar competidores y palabras y lanzar consultas. */
  canEdit: boolean;
  /** Tenant: puede poner su clave de API. */
  canConfigure?: boolean;
}) {
  const ws = useSistrixWorkspace(scope);
  const sync = useSistrixSync(scope);
  const cancel = useCancelSistrixRun(scope);

  if (ws.isError) return <SectionError onRetry={() => void ws.refetch()} />;
  if (ws.isLoading || !ws.data) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const { workspace, settings } = ws.data;

  return (
    <div className="space-y-6">
      {scope.kind === 'tenant' && settings && (
        <TenantSistrixCard settings={settings} canEdit={canConfigure} />
      )}
      {workspace && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Competencia y palabras clave (SISTRIX)</CardTitle>
            <CardDescription>
              Datos de SISTRIX: posiciones y volúmenes nacionales de su muestra, no los de tu
              ciudad. Para tus propias visitas manda Search Console.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <SistrixStatus
              workspace={workspace}
              canEdit={canEdit}
              onSync={(t) => sync.mutateAsync(t)}
              onCancel={(id) => cancel.mutateAsync(id)}
            />
            <Tabs defaultValue="competitors" className="space-y-4">
              <div className="-mx-1 overflow-x-auto px-1">
                <TabsList className="w-max">
                  <TabsTrigger value="competitors">Competidores</TabsTrigger>
                  <TabsTrigger value="ideas">Ideas de palabras</TabsTrigger>
                  <TabsTrigger value="links">Enlaces</TabsTrigger>
                  <TabsTrigger value="ai">Visibilidad en IA</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="competitors">
                <CompetitorsPanel
                  scope={scope}
                  canEdit={canEdit}
                  limit={workspace.limits.competitors}
                />
              </TabsContent>
              <TabsContent value="ideas">
                <KeywordIdeasPanel scope={scope} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="links">
                <BacklinksPanel scope={scope} />
              </TabsContent>
              <TabsContent value="ai">
                <SeoAiVisibilityPanel scope={scope} canEdit={canEdit} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
