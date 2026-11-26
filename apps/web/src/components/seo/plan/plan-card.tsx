'use client';

import { ClipboardList, History } from 'lucide-react';
import { useState } from 'react';

import { SeoChangesPanel } from './changes-panel';
import { ChangeDialog, type ChangeDraft, type PlanDomain } from './plan-dialogs';
import { SeoTasksPanel } from './tasks-panel';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type PlanScope } from '@/lib/seo-advanced/plan-hooks';

/**
 * Sección «Plan» del proyecto SEO: las tareas (tablero, calendario y lista;
 * el calendario de contenidos es la fecha de publicación de las tareas de
 * contenido) y las actuaciones con su antes y después.
 */
export function SeoPlanCard({
  scope,
  canEdit,
  domains,
}: {
  scope: PlanScope;
  canEdit: boolean;
  domains: PlanDomain[];
}) {
  const [tab, setTab] = useState('tasks');
  const [recording, setRecording] = useState<{ draft: ChangeDraft | null } | null>(null);
  return (
    <Card id="plan" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Plan</CardTitle>
        <CardDescription>
          Lo que hay que hacer y lo que ya se ha cambiado en la web, con su efecto en Google.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="tasks">
              <ClipboardList className="mr-1 size-4" aria-hidden /> Tareas
            </TabsTrigger>
            <TabsTrigger value="changes">
              <History className="mr-1 size-4" aria-hidden /> Actuaciones
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tasks" className="mt-4">
            <SeoTasksPanel
              scope={scope}
              canEdit={canEdit}
              domains={domains}
              onRecordChange={(draft) => setRecording({ draft })}
            />
          </TabsContent>
          <TabsContent value="changes" className="mt-4">
            <SeoChangesPanel
              scope={scope}
              canEdit={canEdit}
              domains={domains}
              onRecord={(draft) => setRecording({ draft })}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
      <ChangeDialog
        scope={scope}
        domains={domains}
        open={recording !== null}
        onOpenChange={(v) => !v && setRecording(null)}
        draft={recording?.draft ?? null}
        onSaved={() => {
          setRecording(null);
          setTab('changes');
        }}
      />
    </Card>
  );
}
