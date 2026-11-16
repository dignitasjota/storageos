'use client';

import { renderSalesTemplate, type SalesMaterialDto } from '@storageos/shared';
import { Download, ExternalLink, FileText, Link2, Loader2, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  CopyButton,
  Empty,
  errorText,
  PageHeader,
  SalesPage,
} from '@/components/admin/sales/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  salesMaterialUrl,
  useSalesMaterials,
  useSalesMe,
  useSalesTemplates,
} from '@/lib/admin/sales-hooks';

function MaterialCard({ m }: { m: SalesMaterialDto }) {
  const [open, setOpen] = useState(false);
  const Icon = m.kind === 'file' ? FileText : m.kind === 'link' ? Link2 : StickyNote;

  async function openFile() {
    try {
      const url = await salesMaterialUrl(m.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido abrir.'));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" />
          {m.title}
        </CardTitle>
        {m.description && <CardDescription>{m.description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-2">
        {m.kind === 'note' ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
              {open ? 'Ocultar' : 'Leer'}
            </Button>
            {open && (
              <p className="whitespace-pre-line rounded-md bg-muted/50 p-3 text-sm">{m.body}</p>
            )}
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => void openFile()}>
            {m.kind === 'file' ? (
              <Download className="mr-1.5 size-4" />
            ) : (
              <ExternalLink className="mr-1.5 size-4" />
            )}
            {m.kind === 'file' ? (m.fileName ?? 'Descargar') : 'Abrir'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default function SalesMaterialsPage() {
  const materials = useSalesMaterials();
  const templates = useSalesTemplates();
  const me = useSalesMe();
  const vars = {
    nombre: '[nombre]',
    empresa: '[empresa]',
    comercial: me.data?.fullName ?? null,
    telefono_comercial: me.data?.phone ?? null,
    email_comercial: me.data?.email ?? null,
    agenda: me.data?.bookingUrl ?? null,
    enlace_registro: me.data?.signupUrl ?? null,
    codigo: me.data?.salesCode ?? null,
  };

  return (
    <SalesPage>
      <PageHeader
        title="Materiales"
        description="Lo que prepara la dirección para vender: dossier, tarifas, guiones y plantillas de mensajes."
      />
      <Tabs defaultValue="materials">
        <TabsList>
          <TabsTrigger value="materials">Materiales</TabsTrigger>
          <TabsTrigger value="templates">Plantillas</TabsTrigger>
        </TabsList>
        <TabsContent value="materials">
          {materials.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Cargando…
            </div>
          ) : (materials.data ?? []).length === 0 ? (
            <Empty>La dirección aún no ha subido materiales.</Empty>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {materials.data!.map((m) => (
                <MaterialCard key={m.id} m={m} />
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="templates">
          <p className="mb-3 text-sm text-muted-foreground">
            Desde la ficha de cada cuenta se rellenan solas con sus datos. Aquí puedes copiarlas.
          </p>
          {(templates.data ?? []).length === 0 ? (
            <Empty>No hay plantillas.</Empty>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {templates.data!.map((t) => {
                const text = renderSalesTemplate(t.body, vars);
                return (
                  <Card key={t.id}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">{t.name}</CardTitle>
                      <CardDescription>
                        {t.channel === 'email' ? 'Correo' : 'WhatsApp'}
                        {t.subject && ` · ${renderSalesTemplate(t.subject, vars)}`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <p className="line-clamp-6 whitespace-pre-line text-sm text-muted-foreground">
                        {text}
                      </p>
                      <CopyButton text={text} label="Copiar texto" />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </SalesPage>
  );
}
