'use client';

import {
  SALES_CADENCE_CHANNEL_LABELS,
  SALES_MATERIAL_MAX_BYTES,
  SALES_MATERIAL_MIME_TYPES,
  SALES_TEMPLATE_VARIABLES,
  type SalesCadenceDto,
  type SalesCadenceStep,
  type SalesMaterialDto,
  type SalesMaterialKind,
  type SalesTemplateDto,
} from '@storageos/shared';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  Empty,
  errorText,
  Field,
  PageHeader,
  QueryState,
  SalesPage,
} from '@/components/admin/sales/common';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  uploadSalesMaterial,
  useDeleteCadence,
  useDeleteMaterial,
  useDeleteTemplate,
  useSaveCadence,
  useSaveMaterial,
  useSaveTemplate,
  useTeamCadences,
  useTeamMaterials,
  useTeamTemplates,
} from '@/lib/admin/sales-team-hooks';

// ------------------------------------------------------------- materiales

function MaterialDialog({
  material,
  onClose,
}: {
  material: SalesMaterialDto | null;
  onClose: () => void;
}) {
  const save = useSaveMaterial();
  const [kind, setKind] = useState<SalesMaterialKind>(material?.kind ?? 'file');
  const [title, setTitle] = useState(material?.title ?? '');
  const [description, setDescription] = useState(material?.description ?? '');
  const [url, setUrl] = useState(material?.url ?? '');
  const [body, setBody] = useState(material?.body ?? '');
  const [file, setFile] = useState<{ key: string; fileName: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  async function pick(f: File | undefined) {
    if (!f) return;
    if (!(SALES_MATERIAL_MIME_TYPES as readonly string[]).includes(f.type)) {
      toast.error('Sube un PDF, una imagen o un documento de Office.');
      return;
    }
    if (f.size > SALES_MATERIAL_MAX_BYTES) {
      toast.error('Como mucho 20 MB.');
      return;
    }
    setUploading(true);
    try {
      setFile(await uploadSalesMaterial(f));
      if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido subir.'));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    try {
      await save.mutateAsync({
        id: material?.id ?? null,
        input: {
          title: title.trim(),
          description: description.trim(),
          kind,
          position: material?.position ?? 0,
          ...(kind === 'link' ? { url: url.trim() } : {}),
          ...(kind === 'note' ? { body: body.trim() } : {}),
          // Al editar sin subir otro fichero se conserva el que tenía.
          ...(kind === 'file' && file ? { fileKey: file.key, fileName: file.fileName } : {}),
        },
      });
      toast.success('Guardado.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const canSave =
    title.trim().length >= 2 &&
    (kind === 'link'
      ? !!url.trim()
      : kind === 'note'
        ? !!body.trim()
        : !!file || material?.kind === 'file');

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{material ? 'Editar material' : 'Nuevo material'}</DialogTitle>
          <DialogDescription>Lo ven todos los comerciales en «Materiales».</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!material && (
            <Field label="Tipo">
              <Select value={kind} onValueChange={(v) => setKind(v as SalesMaterialKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="file">Fichero (PDF, imagen, Office)</SelectItem>
                  <SelectItem value="link">Enlace</SelectItem>
                  <SelectItem value="note">Texto (guion, argumentario…)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Título">
            <Input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Descripción (opcional)">
            <Input
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {kind === 'file' && (
            <Field
              label="Fichero"
              hint={
                file
                  ? `Subido: ${file.fileName}`
                  : material?.fileName
                    ? `Actual: ${material.fileName}`
                    : 'Hasta 20 MB.'
              }
            >
              <Input
                type="file"
                disabled={uploading}
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            </Field>
          )}
          {kind === 'link' && (
            <Field label="Enlace">
              <Input
                type="url"
                value={url}
                maxLength={1000}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          )}
          {kind === 'note' && (
            <Field label="Texto">
              <Textarea
                rows={10}
                value={body}
                maxLength={20_000}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!canSave || uploading || save.isPending} onClick={() => void submit()}>
            {(uploading || save.isPending) && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MaterialsTab() {
  const materials = useTeamMaterials();
  const remove = useDeleteMaterial();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<SalesMaterialDto | null | 'new'>(null);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1 size-4" />
          Nuevo material
        </Button>
      </div>
      {editing && (
        <MaterialDialog
          material={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {materials.isLoading || materials.isError ? (
        <QueryState query={materials} />
      ) : (materials.data ?? []).length === 0 ? (
        <Empty>Sube el dossier, las tarifas o el guion de llamada para tus comerciales.</Empty>
      ) : (
        <ul className="divide-y rounded-md border">
          {materials.data!.map((m) => (
            <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{m.title}</p>
                <p className="text-xs text-muted-foreground">
                  {m.kind === 'file'
                    ? (m.fileName ?? 'Fichero')
                    : m.kind === 'link'
                      ? m.url
                      : 'Texto'}
                  {m.description && ` · ${m.description}`}
                </p>
              </div>
              <Button size="icon" variant="ghost" aria-label="Editar" onClick={() => setEditing(m)}>
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Borrar"
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Borrar «${m.title}»`,
                      confirmLabel: 'Borrar',
                      destructive: true,
                    }))
                  )
                    return;
                  remove.mutate(m.id, { onError: (e) => toast.error(errorText(e)) });
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------- plantillas

function TemplateDialog({
  template,
  onClose,
}: {
  template: SalesTemplateDto | null;
  onClose: () => void;
}) {
  const save = useSaveTemplate();
  const [name, setName] = useState(template?.name ?? '');
  const [channel, setChannel] = useState<'email' | 'whatsapp'>(template?.channel ?? 'email');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [isActive, setIsActive] = useState(template?.isActive ?? true);

  async function submit() {
    try {
      await save.mutateAsync({
        id: template?.id ?? null,
        input: {
          name: name.trim(),
          channel,
          subject: channel === 'email' ? subject.trim() : null,
          body: body.trim(),
          position: template?.position ?? 0,
          isActive,
        },
      });
      toast.success('Guardada.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? 'Editar plantilla' : 'Nueva plantilla'}</DialogTitle>
          <DialogDescription>
            Variables:{' '}
            {Object.entries(SALES_TEMPLATE_VARIABLES)
              .map(([k, v]) => `{${k}} (${v.toLowerCase()})`)
              .join(', ')}
            .
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre">
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Canal">
              <Select value={channel} onValueChange={(v) => setChannel(v as 'email' | 'whatsapp')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Correo</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {channel === 'email' && (
            <Field label="Asunto">
              <Input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            </Field>
          )}
          <Field label="Texto">
            <Textarea
              rows={10}
              value={body}
              maxLength={10_000}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Activa
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={
              name.trim().length < 2 ||
              body.trim().length < 2 ||
              (channel === 'email' && !subject.trim()) ||
              save.isPending
            }
            onClick={() => void submit()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplatesTab() {
  const templates = useTeamTemplates();
  const remove = useDeleteTemplate();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<SalesTemplateDto | null | 'new'>(null);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1 size-4" />
          Nueva plantilla
        </Button>
      </div>
      {editing && (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {templates.isLoading || templates.isError ? (
        <QueryState query={templates} />
      ) : (templates.data ?? []).length === 0 ? (
        <Empty>Sin plantillas.</Empty>
      ) : (
        <ul className="divide-y rounded-md border">
          {templates.data!.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {t.name} {!t.isActive && <Badge variant="secondary">Inactiva</Badge>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.channel === 'email' ? `Correo · ${t.subject ?? ''}` : 'WhatsApp'}
                </p>
              </div>
              <Button size="icon" variant="ghost" aria-label="Editar" onClick={() => setEditing(t)}>
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Borrar"
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Borrar «${t.name}»`,
                      confirmLabel: 'Borrar',
                      destructive: true,
                    }))
                  )
                    return;
                  remove.mutate(t.id, { onError: (e) => toast.error(errorText(e)) });
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -------------------------------------------------------------- cadencias

function CadenceDialog({
  cadence,
  onClose,
}: {
  cadence: SalesCadenceDto | null;
  onClose: () => void;
}) {
  const save = useSaveCadence();
  const [name, setName] = useState(cadence?.name ?? '');
  const [description, setDescription] = useState(cadence?.description ?? '');
  const [isActive, setIsActive] = useState(cadence?.isActive ?? true);
  const [steps, setSteps] = useState<SalesCadenceStep[]>(
    cadence?.steps.length ? cadence.steps : [{ day: 0, channel: 'call', title: 'Primera llamada' }],
  );

  function setStep(i: number, patch: Partial<SalesCadenceStep>) {
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }

  async function submit() {
    try {
      await save.mutateAsync({
        id: cadence?.id ?? null,
        input: { name: name.trim(), description: description.trim() || null, steps, isActive },
      });
      toast.success('Guardada.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cadence ? 'Editar cadencia' : 'Nueva cadencia'}</DialogTitle>
          <DialogDescription>
            Pasos con su día (0 = el día que se empieza). Cada paso queda como un seguimiento en la
            agenda del comercial.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Nombre">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Para qué sirve (opcional)">
            <Input
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  className="w-20"
                  type="number"
                  min={0}
                  max={180}
                  value={s.day}
                  aria-label="Día"
                  onChange={(e) =>
                    setStep(i, { day: Math.max(0, Math.min(180, e.target.valueAsNumber || 0)) })
                  }
                />
                <Select
                  value={s.channel}
                  onValueChange={(v) => setStep(i, { channel: v as SalesCadenceStep['channel'] })}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      Object.keys(SALES_CADENCE_CHANNEL_LABELS) as SalesCadenceStep['channel'][]
                    ).map((c) => (
                      <SelectItem key={c} value={c}>
                        {SALES_CADENCE_CHANNEL_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="min-w-[180px] flex-1"
                  value={s.title}
                  maxLength={160}
                  onChange={(e) => setStep(i, { title: e.target.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Quitar paso"
                  disabled={steps.length === 1}
                  onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={steps.length >= 20}
              onClick={() =>
                setSteps((x) => [
                  ...x,
                  { day: (x.at(-1)?.day ?? 0) + 3, channel: 'call', title: 'Llamar' },
                ])
              }
            >
              <Plus className="mr-1 size-4" />
              Añadir paso
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Activa
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={
              name.trim().length < 2 ||
              steps.some((s) => s.title.trim().length < 2) ||
              save.isPending
            }
            onClick={() => void submit()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CadencesTab() {
  const cadences = useTeamCadences();
  const remove = useDeleteCadence();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<SalesCadenceDto | null | 'new'>(null);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1 size-4" />
          Nueva cadencia
        </Button>
      </div>
      {editing && (
        <CadenceDialog
          cadence={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {cadences.isLoading || cadences.isError ? (
        <QueryState query={cadences} />
      ) : (cadences.data ?? []).length === 0 ? (
        <Empty>Sin cadencias.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {cadences.data!.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                <div>
                  <CardTitle className="text-base">
                    {c.name} {!c.isActive && <Badge variant="secondary">Inactiva</Badge>}
                  </CardTitle>
                  {c.description && <CardDescription>{c.description}</CardDescription>}
                </div>
                <div className="flex">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Editar"
                    onClick={() => setEditing(c)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Borrar"
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: `Borrar «${c.name}»`,
                          description:
                            'Si alguna cuenta la ha usado, se desactiva para conservar su historial.',
                          confirmLabel: 'Borrar',
                          destructive: true,
                        }))
                      )
                        return;
                      remove.mutate(c.id, { onError: (e) => toast.error(errorText(e)) });
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-0.5 text-sm text-muted-foreground">
                  {c.steps.map((s, i) => (
                    <li key={i}>
                      Día {s.day} · {SALES_CADENCE_CHANNEL_LABELS[s.channel]} · {s.title}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SalesContentPage() {
  return (
    <SalesPage>
      <PageHeader
        title="Materiales y plantillas"
        description="Lo que preparas para que tus comerciales vendan: ficheros, plantillas de mensajes y cadencias de contacto."
      />
      <Tabs defaultValue="materials">
        <TabsList>
          <TabsTrigger value="materials">Materiales</TabsTrigger>
          <TabsTrigger value="templates">Plantillas</TabsTrigger>
          <TabsTrigger value="cadences">Cadencias</TabsTrigger>
        </TabsList>
        <TabsContent value="materials">
          <MaterialsTab />
        </TabsContent>
        <TabsContent value="templates">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="cadences">
          <CadencesTab />
        </TabsContent>
      </Tabs>
    </SalesPage>
  );
}
