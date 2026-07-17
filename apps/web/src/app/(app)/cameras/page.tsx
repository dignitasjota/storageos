'use client';

import {
  CAMERA_PROVIDER_LABELS,
  CameraProviderEnum,
  type CameraProviderValue,
} from '@storageos/shared';
import { Camera, Copy, Loader2, Trash2, Video } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { CameraDeviceWithTokenDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import {
  useCameraDevices,
  useCameraEvents,
  useCreateCameraDevice,
  useDeleteCameraDevice,
} from '@/lib/cameras/hooks';
import { useFacilities } from '@/lib/facilities/hooks';


export default function CamerasPage() {
  const devices = useCameraDevices();
  const [kindFilter, setKindFilter] = useState<'all' | 'camera' | 'alarm'>('all');
  const events = useCameraEvents(undefined, kindFilter === 'all' ? undefined : kindFilter);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<CameraDeviceWithTokenDto | null>(null);
  const del = useDeleteCameraDevice();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cámaras y alarma</h1>
          <p className="text-sm text-muted-foreground">
            Eventos e imágenes de tus cámaras/alarma. El vídeo en vivo se ve en la app del
            fabricante (DMSS).
          </p>
        </div>
        <Can permission="access:manage">
          <Button onClick={() => setCreateOpen(true)}>
            <Camera className="mr-1 h-4 w-4" /> Añadir cámara
          </Button>
        </Can>
      </div>

      {/* Dispositivos */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dispositivos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {devices.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (devices.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aún no hay cámaras. Añade una y configura tu equipo/NVR para empujar los eventos a la
              URL de ingesta.
            </p>
          ) : (
            <div className="divide-y">
              {(devices.data ?? []).map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{d.name}</span>
                      <Badge variant="outline">canal {d.channel}</Badge>
                      <Badge variant="outline">{CAMERA_PROVIDER_LABELS[d.provider]}</Badge>
                      {!d.isActive && <Badge variant="secondary">inactiva</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {d.facilityName} · token {d.ingestTokenPreview}… ·{' '}
                      {d.lastEventAt
                        ? `último evento ${new Date(d.lastEventAt).toLocaleString('es-ES')}`
                        : 'sin eventos aún'}
                    </p>
                  </div>
                  <Can permission="access:manage">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Eliminar"
                      onClick={() => {
                        if (window.confirm(`¿Eliminar la cámara «${d.name}»?`)) del.mutate(d.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </Can>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Feed de eventos */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Últimos eventos</CardTitle>
          <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="camera">Cámara</SelectItem>
              <SelectItem value="alarm">Alarma</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {events.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (events.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin eventos todavía.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(events.data ?? []).map((e) => (
                <div key={e.id} className="overflow-hidden rounded-lg border">
                  {e.snapshotUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={e.snapshotUrl}
                      alt={e.eventType}
                      className="h-32 w-full bg-muted object-cover"
                    />
                  ) : (
                    <div className="flex h-32 w-full items-center justify-center bg-muted text-muted-foreground">
                      <Video className="h-6 w-6" />
                    </div>
                  )}
                  <div className="space-y-0.5 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{e.eventType}</span>
                      <Badge variant={e.kind === 'alarm' ? 'destructive' : 'outline'}>
                        {e.kind === 'alarm' ? 'Alarma' : 'Cámara'}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {e.cameraName} · {new Date(e.occurredAt).toLocaleString('es-ES')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateCameraDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onRevealed={(d) => {
          setCreateOpen(false);
          setRevealed(d);
        }}
      />
      <RevealTokenDialog device={revealed} onClose={() => setRevealed(null)} />
    </div>
  );
}

function CreateCameraDialog({
  open,
  onClose,
  onRevealed,
}: {
  open: boolean;
  onClose: () => void;
  onRevealed: (d: CameraDeviceWithTokenDto) => void;
}) {
  const facilities = useFacilities();
  const create = useCreateCameraDevice();
  const [facilityId, setFacilityId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('1');
  const [provider, setProvider] = useState<CameraProviderValue>('dahua');
  const [serialNumber, setSerialNumber] = useState('');

  async function submit() {
    if (!facilityId || !name.trim()) {
      toast.error('Indica el local y el nombre.');
      return;
    }
    try {
      const dto = await create.mutateAsync({
        facilityId,
        name: name.trim(),
        channel: Number(channel) || 1,
        provider,
        metadata: {},
        ...(serialNumber.trim() ? { serialNumber: serialNumber.trim() } : {}),
      });
      setName('');
      setSerialNumber('');
      onRevealed(dto);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Añadir cámara / alarma</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Local</Label>
            <Select value={facilityId} onValueChange={setFacilityId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un local" />
              </SelectTrigger>
              <SelectContent>
                {(facilities.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Nombre</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cámara pasillo 1" />
          </div>
          <div className="space-y-1">
            <Label>Marca del equipo</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as CameraProviderValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CameraProviderEnum.options.map((p) => (
                  <SelectItem key={p} value={p}>
                    {CAMERA_PROVIDER_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              La ingesta de eventos es igual para todas; la marca se usará para acciones futuras
              (snapshot bajo demanda, armar/desarmar la alarma).
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Canal (NVR)</Label>
              <Input
                type="number"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                min={1}
              />
            </div>
            <div className="space-y-1">
              <Label>Nº de serie (opcional)</Label>
              <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
            </div>
          </div>
          <Button onClick={submit} disabled={create.isPending} className="w-full">
            {create.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Crear
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RevealTokenDialog({
  device,
  onClose,
}: {
  device: CameraDeviceWithTokenDto | null;
  onClose: () => void;
}) {
  function copy(text: string) {
    void navigator.clipboard.writeText(text);
    toast.success('Copiado.');
  }
  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configura tu equipo</DialogTitle>
        </DialogHeader>
        {device && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Configura el «linkage» de alarma de tu cámara/NVR (HTTP/FTP) para que envíe los
              eventos a esta URL con la cabecera <code>X-Camera-Token</code>. El token solo se
              muestra ahora.
            </p>
            <Field label="URL de ingesta" value={device.ingestUrl} onCopy={copy} />
            <Field label="X-Camera-Token" value={device.revealedIngestToken} onCopy={copy} mono />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  onCopy: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} className={mono ? 'font-mono text-xs' : 'text-xs'} />
        <Button variant="outline" size="icon" aria-label="Copiar" onClick={() => onCopy(value)}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
