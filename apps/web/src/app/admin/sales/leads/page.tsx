'use client';

import {
  PLATFORM_LEAD_STAGE_LABELS,
  PLATFORM_LEAD_STAGES,
  type SalesImportResultDto,
} from '@storageos/shared';
import { FileUp, Loader2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  Empty,
  errorText,
  PageHeader,
  ProfileGlance,
  relativeDays,
  SalesPage,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import { NewProspectDialog } from '@/components/admin/sales/new-prospect-dialog';
import { Button } from '@/components/ui/button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useSalesImport, useSalesLeads } from '@/lib/admin/sales-hooks';
import { cn } from '@/lib/utils';

const ALL = 'all';
const FILTERS: { value: string; label: string }[] = [
  { value: ALL, label: 'Todos' },
  { value: 'no_contact', label: 'Sin contacto hace tiempo' },
  { value: 'trial_ending', label: 'Prueba que acaba' },
  { value: 'pending', label: 'Pendientes de asignar' },
];

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const run = useSalesImport();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<SalesImportResultDto | null>(null);

  async function go(commit: boolean) {
    try {
      const res = await run.mutateAsync({ csv, commit });
      setResult(res);
      if (commit) {
        toast.success(`${res.created} prospectos añadidos a tu cartera.`);
        setCsv('');
        setResult(null);
        onClose();
      }
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido leer el fichero.'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setResult(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar prospectos</DialogTitle>
          <DialogDescription>
            Un CSV con columnas como empresa, contacto, email, teléfono, ciudad, trasteros, locales,
            programa y nota (separado por «;» o «,»). Los que ya son contacto de TrasterOS no se
            importan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void file.text().then((t) => {
                setCsv(t);
                setResult(null);
              });
            }}
          />
          <Textarea
            rows={6}
            className="font-mono text-xs"
            placeholder={
              'empresa;contacto;email;telefono;ciudad\nTrasteros Sol;Marta;marta@ejemplo.com;600111222;Málaga'
            }
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setResult(null);
            }}
          />
        </div>
        {result && (
          <div className="space-y-2">
            <p className="text-sm">
              {result.valid} para importar · {result.duplicates} ya existen · {result.errors} con
              errores
            </p>
            <div className="max-h-64 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Línea</TableHead>
                    <TableHead>Empresa / contacto</TableHead>
                    <TableHead>Email / teléfono</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((r) => (
                    <TableRow key={r.line}>
                      <TableCell className="tabular-nums">{r.line}</TableCell>
                      <TableCell>{r.companyName ?? r.contactName ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {r.email ?? ''} {r.phone ?? ''}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-xs',
                          r.error
                            ? 'text-destructive'
                            : r.duplicate
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-emerald-700 dark:text-emerald-400',
                        )}
                      >
                        {r.error ?? (r.duplicate ? 'Ya existe' : 'Se importará')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          {!result ? (
            <Button disabled={!csv.trim() || run.isPending} onClick={() => void go(false)}>
              {run.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Revisar
            </Button>
          ) : (
            <Button disabled={result.valid === 0 || run.isPending} onClick={() => void go(true)}>
              {run.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Importar {result.valid}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SalesLeadsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const [filter, setFilter] = useState<string>(ALL);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const leads = useSalesLeads({
    ...(search.trim().length >= 2 ? { search: search.trim() } : {}),
    ...(status !== ALL ? { status } : {}),
    ...(filter !== ALL ? { filter } : {}),
  });
  const counts = leads.data?.counts ?? {};

  return (
    <SalesPage>
      <PageHeader
        title="Prospectos"
        description="Tu cartera: lo que llevas tú, desde el primer contacto hasta que paga."
        actions={
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <FileUp className="mr-1.5 size-4" />
              Importar
            </Button>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              Nuevo prospecto
            </Button>
          </>
        }
      />
      <NewProspectDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setStatus(ALL)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs',
            status === ALL ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
          )}
        >
          Todas las fases
        </button>
        {PLATFORM_LEAD_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              status === s ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
            )}
          >
            {PLATFORM_LEAD_STAGE_LABELS[s]} {counts[s] ? `· ${counts[s]}` : ''}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Buscar por empresa, persona, email, teléfono o ciudad"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[230px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {leads.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      ) : (leads.data?.items.length ?? 0) === 0 ? (
        <Empty>No hay prospectos con estos filtros.</Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuenta</TableHead>
                <TableHead>Fase</TableHead>
                <TableHead className="hidden md:table-cell">Último contacto</TableHead>
                <TableHead className="hidden md:table-cell">Siguiente paso</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.data!.items.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <Link
                      href={`/admin/sales/accounts/${l.id}`}
                      className="font-medium hover:underline"
                    >
                      {l.displayName}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {l.contactName && l.companyName && <span>{l.contactName}</span>}
                      {l.phone && (
                        <span>
                          ·{' '}
                          <a
                            href={`tel:${l.phone.replace(/\s+/g, '')}`}
                            className="hover:text-foreground hover:underline"
                          >
                            {l.phone}
                          </a>
                        </span>
                      )}
                      <TemperatureBadge value={l.salesProfile?.temperature} />
                    </div>
                    <ProfileGlance profile={l.salesProfile} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <span className="text-xs">{PLATFORM_LEAD_STAGE_LABELS[l.status]}</span>
                      {l.tenantStatus && <TenantStatusBadge status={l.tenantStatus} />}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {relativeDays(l.salesProfile?.lastContactAt ?? l.lastActivityAt)}
                  </TableCell>
                  <TableCell className="hidden text-xs md:table-cell">
                    {l.nextFollowup ? (
                      <>
                        {l.nextFollowup.title}
                        <span className="block text-muted-foreground">
                          {relativeDays(l.nextFollowup.dueDate)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SalesPage>
  );
}
