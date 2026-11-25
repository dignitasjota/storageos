'use client';

import {
  SEO_STRATEGY_LABELS,
  type CreateSeoProjectInput,
  type SeoProjectDto,
} from '@storageos/shared';
import { ArrowRight, Globe, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { AdminError } from '@/components/admin/admin-error';
import { SeoChange } from '@/components/seo/seo-change';
import { SeoProjectDialog } from '@/components/seo/seo-project-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useAdminSeoOverview,
  useAdminSeoProjects,
  useAdminSeoTenantProjects,
  useCreateAdminSeoProject,
} from '@/lib/admin/seo-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { formatCount, formatDate, formatDateTime, formatNumber, formatPct } from '@/lib/format';

const STATUS_TEXT: Record<string, string> = {
  connected: 'conectado',
  pending: 'pendiente',
  error: 'sin acceso',
};

function ProjectCard({ project }: { project: SeoProjectDto }) {
  const primary = project.domains.find((d) => d.role === 'primary') ?? project.domains[0];
  return (
    <Link href={`/admin/seo/${project.id}`} className="group block">
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader className="space-y-1">
          <CardTitle className="flex items-start justify-between gap-2 text-base">
            <span className="break-words">{project.name}</span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </CardTitle>
          <CardDescription>
            {SEO_STRATEGY_LABELS[project.strategy]}
            {project.status === 'paused' ? ' · en pausa' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {project.domains.length === 0 ? (
            <p className="text-muted-foreground">Sin dominios todavía.</p>
          ) : (
            <ul className="space-y-1">
              {project.domains.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{d.domain}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {d.activeRun ? 'descargando…' : STATUS_TEXT[d.connectionStatus]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {primary?.dataUntil && (
            <p className="text-xs text-muted-foreground">
              Datos hasta el {formatDate(primary.dataUntil)}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

function TenantProjects() {
  const list = useAdminSeoTenantProjects(true);
  if (list.isError) return <AdminError onRetry={() => void list.refetch()} />;
  if (list.isLoading || !list.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (list.data.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Ningún tenant ha creado todavía su proyecto de SEO Avanzado.
      </p>
    );
  }
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {list.data.map((p) => (
          <Link
            key={p.id}
            href={`/admin/seo/${p.id}`}
            className="flex flex-col gap-2 p-4 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.tenantName}</span>
                {!p.featureEnabled && (
                  <Badge variant="secondary">Sin el extra (no se descarga)</Badge>
                )}
                {p.status === 'paused' && <Badge variant="outline">En pausa</Badge>}
              </div>
              <p className="break-all text-xs text-muted-foreground">
                {p.domains.length === 0
                  ? 'Sin dominios'
                  : p.domains
                      .map((d) => `${d.domain} (${STATUS_TEXT[d.connectionStatus]})`)
                      .join(' · ')}
              </p>
            </div>
            <p className="shrink-0 text-xs text-muted-foreground">
              {p.lastSyncedAt
                ? `Última descarga ${formatDateTime(p.lastSyncedAt)}`
                : 'Sin descargas'}
            </p>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Vista global: los últimos 28 días de cada proyecto (plataforma y tenants)
 * frente a los 28 anteriores, de su dominio principal. Cada uno con sus datos,
 * sin sumar proyectos.
 */
function ProjectsOverview() {
  const overview = useAdminSeoOverview();
  if (overview.isError) return <AdminError onRetry={() => void overview.refetch()} />;
  if (overview.isLoading || !overview.data) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (overview.data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Todos los proyectos, últimos 28 días
          <Badge variant="outline" className="font-normal">
            Datos de Google Search Console
          </Badge>
        </CardTitle>
        <CardDescription>
          El dominio principal de cada proyecto, frente a sus 28 días anteriores. Los de los
          tenants, en solo lectura.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Proyecto</TableHead>
              <TableHead className="text-right">Clics</TableHead>
              <TableHead className="text-right">Impresiones</TableHead>
              <TableHead className="text-right">CTR</TableHead>
              <TableHead className="text-right">Posición</TableHead>
              <TableHead className="text-right">Últimos datos</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.data.map((p) => (
              <TableRow key={p.projectId}>
                <TableCell className="min-w-[12rem]">
                  <Link href={`/admin/seo/${p.projectId}`} className="font-medium hover:underline">
                    {p.tenantId ? (p.tenantName ?? p.name) : p.name}
                  </Link>
                  <p className="break-all text-xs text-muted-foreground">
                    {p.domain ?? 'Sin dominio'}
                    {p.tenantId ? ' · tenant' : ' · TrasterOS'}
                  </p>
                </TableCell>
                <TableCell className="text-right">
                  <p className="tabular-nums">{formatCount(p.current.clicks)}</p>
                  <SeoChange value={p.change?.clicksPct} suffix=" %" />
                </TableCell>
                <TableCell className="text-right">
                  <p className="tabular-nums">{formatCount(p.current.impressions)}</p>
                  <SeoChange value={p.change?.impressionsPct} suffix=" %" />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.current.ctr == null ? '—' : formatPct(p.current.ctr * 100)}
                </TableCell>
                <TableCell className="text-right">
                  <p className="tabular-nums">
                    {p.current.position == null ? '—' : formatNumber(p.current.position, 1)}
                  </p>
                  <SeoChange value={p.change?.positionDiff} suffix=" puestos" />
                </TableCell>
                <TableCell className="text-right text-xs">
                  {p.lastDate ? formatDate(p.lastDate) : '—'}
                  {p.delayed && (
                    <Badge className="ml-1 border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300">
                      Con retraso
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Panel admin → SEO → Proyectos: los de trasteros.pro y, en lectura, los de los tenants. */
export default function AdminSeoProjectsPage() {
  const router = useRouter();
  const canEdit = useIsSuperadmin();
  const projects = useAdminSeoProjects();
  const create = useCreateAdminSeoProject();
  const [open, setOpen] = useState(false);

  const submit = async (input: CreateSeoProjectInput) => {
    const created = await create.mutateAsync(input);
    router.push(`/admin/seo/${created.id}`);
  };

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Proyectos de SEO</h1>
          <p className="text-sm text-muted-foreground">
            Lo que dice Google de cada web: búsquedas, páginas, países y dispositivos, día a día y
            con hasta 16 meses de historia.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!canEdit} className="shrink-0">
          <Plus className="mr-1 size-4" aria-hidden /> Nuevo proyecto
        </Button>
      </div>

      <ProjectsOverview />

      <Tabs defaultValue="platform">
        <TabsList>
          <TabsTrigger value="platform">TrasterOS</TabsTrigger>
          <TabsTrigger value="tenants">Proyectos de los tenants</TabsTrigger>
        </TabsList>
        <TabsContent value="platform" className="mt-4">
          {projects.isError ? (
            <AdminError onRetry={() => void projects.refetch()} />
          ) : projects.isLoading || !projects.data ? (
            <div className="flex justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : projects.data.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  Crea el primer proyecto (por ejemplo, trasteros.pro) y añade sus dominios.
                </p>
                {canEdit && (
                  <Button onClick={() => setOpen(true)}>
                    <Plus className="mr-1 size-4" aria-hidden /> Nuevo proyecto
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {projects.data.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="tenants" className="mt-4">
          <TenantProjects />
        </TabsContent>
      </Tabs>

      <SeoProjectDialog open={open} onOpenChange={setOpen} onSubmit={submit} />
    </div>
  );
}
