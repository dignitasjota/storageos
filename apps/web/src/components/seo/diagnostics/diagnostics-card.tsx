'use client';

import { Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { CannibalizationPanel } from './cannibalization-panel';
import { DiagnosticSettingsDialog } from './diagnostic-settings-dialog';
import { IndexPanel } from './index-panel';
import { TrackedKeywordsPanel } from './tracked-keywords-panel';

import type { SeoProjectDomainDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCount } from '@/lib/format';
import {
  type DiagnosticScope,
  useCannibalizationSummary,
  useIndexSummary,
  useRecalculateDiagnostics,
} from '@/lib/seo-advanced/diagnostic-hooks';

function Count({ n, tone }: { n: number | undefined; tone?: 'alert' }) {
  if (!n) return null;
  return (
    <Badge
      variant={tone === 'alert' ? 'destructive' : 'secondary'}
      className="ml-1.5 h-5 px-1.5 font-normal tabular-nums"
    >
      {formatCount(n)}
    </Badge>
  );
}

/**
 * Diagnóstico del proyecto en tres pestañas: palabras seguidas (con su URL
 * objetivo frente a la que enseña Google), canibalización e indexación. Lo
 * usan la ficha del proyecto del panel admin y SEO Avanzado del tenant.
 */
export function SeoDiagnosticsCard({
  scope,
  canEdit,
  domains,
}: {
  scope: DiagnosticScope;
  canEdit: boolean;
  domains: SeoProjectDomainDto[];
}) {
  const cannibal = useCannibalizationSummary(scope);
  const index = useIndexSummary(scope);
  const recalc = useRecalculateDiagnostics(scope);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const run = async () => {
    try {
      const r = await recalc.mutateAsync();
      toast.success(
        `${formatCount(r.cannibalization.detected)} búsquedas canibalizadas y ${formatCount(r.index.detected)} páginas que no deberían estar`,
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-base">Palabras seguidas y diagnóstico</CardTitle>
          <CardDescription>
            Tus palabras con su evolución en Google, las búsquedas en las que tus páginas compiten
            entre sí y las páginas que salen en Google y no deberían.
          </CardDescription>
        </div>
        {canEdit && (
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-1 size-4" aria-hidden /> Ajustes
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void run()}
              disabled={recalc.isPending}
            >
              {recalc.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="mr-1 size-4" aria-hidden />
              )}
              Recalcular
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="keywords" className="space-y-4">
          <div className="-mx-1 overflow-x-auto px-1">
            <TabsList className="w-max">
              <TabsTrigger value="keywords">Palabras seguidas</TabsTrigger>
              <TabsTrigger value="cannibalization">
                Canibalización
                <Count n={cannibal.data?.bySeverity.high} tone="alert" />
                <Count
                  n={
                    cannibal.data
                      ? cannibal.data.bySeverity.medium + cannibal.data.bySeverity.low
                      : undefined
                  }
                />
              </TabsTrigger>
              <TabsTrigger value="index">
                Indexación
                <Count n={index.data?.open} />
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="keywords">
            <TrackedKeywordsPanel scope={scope} canEdit={canEdit} domains={domains} />
          </TabsContent>
          <TabsContent value="cannibalization">
            <CannibalizationPanel scope={scope} canEdit={canEdit} />
          </TabsContent>
          <TabsContent value="index">
            <IndexPanel scope={scope} canEdit={canEdit} />
          </TabsContent>
        </Tabs>
      </CardContent>
      {canEdit && (
        <DiagnosticSettingsDialog
          scope={scope}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </Card>
  );
}
