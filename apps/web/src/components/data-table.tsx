'use client';

import {
  type ColumnDef,
  type ColumnFiltersState,
  type RowData,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Metadatos opcionales por columna para afinar la vista móvil (tarjetas):
// `mobileLabel` da una etiqueta cuando el header no es un string (p. ej. un
// checkbox de selección), y `mobileHidden` oculta la columna en la tarjeta.
declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    mobileLabel?: string;
    mobileHidden?: boolean;
  }
}

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Activa input de búsqueda global (filtra todas las columnas). */
  searchPlaceholder?: string;
  /** Componente extra arriba a la derecha (botón "Crear", etc.). */
  toolbarRight?: React.ReactNode;
  /** Filas por página. Default 25. */
  pageSize?: number;
  /** Render custom cuando no hay filas. */
  emptyText?: string;
  /** Estado loading: muestra skeleton-like text. */
  isLoading?: boolean;
  /**
   * Búsqueda en el servidor (listas paginadas): el campo de búsqueda filtra en
   * el API en vez de solo entre las filas cargadas.
   */
  serverSearch?: { value: string; onChange: (value: string) => void; placeholder: string };
  /** Lista paginada en el servidor: muestra todo lo cargado y «Cargar más». */
  loadMore?: { hasMore: boolean; loading: boolean; onLoadMore: () => void };
  /**
   * Ficha de cada fila: pulsar en cualquier punto de la fila (o de la tarjeta
   * en el móvil) la abre. Ctrl/⌘ o el botón central la abren en otra pestaña.
   */
  rowHref?: (row: TData) => string | null | undefined;
  /** Alternativa a `rowHref` cuando el detalle es un diálogo. */
  onRowClick?: (row: TData) => void;
}

/**
 * Elementos que tienen su propia acción dentro de una fila: el clic en ellos no
 * abre la ficha (menús, casillas, enlaces a otras fichas, campos…).
 */
const INTERACTIVE =
  'a, button, input, select, textarea, label, [role="checkbox"], [role="menuitem"], [role="combobox"], [data-row-click-ignore]';

function isInteractiveTarget(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  // Menús y diálogos abiertos desde la fila se pintan fuera de ella (portal),
  // pero sus clics llegan a la fila por el árbol de React: no son de la fila.
  if (!row.contains(target)) return true;
  const hit = target.closest(INTERACTIVE);
  // Un elemento interactivo dentro de la fila (no la propia fila).
  return !!hit && hit !== row && row.contains(hit);
}

/** El usuario está seleccionando texto de la fila: no navegar. */
function isSelectingText(): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  return !!sel && sel.type === 'Range' && sel.toString().trim().length > 0;
}

/**
 * Wrapper sobre `<Table>` de shadcn con TanStack Table v8.
 * Sorting + filtering + paginación client-side. Cuando lleguen
 * tablas con mil+ filas se podrá pasar a server-side via `manualPagination`,
 * `manualSorting` y `manualFiltering` sin cambiar la API.
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  searchPlaceholder,
  toolbarRight,
  pageSize = 25,
  emptyText = 'No hay datos para mostrar.',
  isLoading,
  serverSearch,
  loadMore,
  rowHref,
  onRowClick,
}: DataTableProps<TData, TValue>) {
  const router = useRouter();
  const clickable = !!rowHref || !!onRowClick;

  /** Abre la fila. `newTab`: Ctrl/⌘ o botón central (solo con enlace). */
  function openRow(row: TData, newTab: boolean) {
    const href = rowHref?.(row);
    if (href) {
      if (newTab) window.open(href, '_blank', 'noopener');
      else router.push(href);
      return;
    }
    onRowClick?.(row);
  }

  function rowProps(row: TData) {
    if (!clickable) return {};
    return {
      tabIndex: 0,
      role: rowHref ? 'link' : 'button',
      className:
        'cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
      onClick: (e: React.MouseEvent<HTMLElement>) => {
        if (isInteractiveTarget(e.target, e.currentTarget) || isSelectingText()) return;
        openRow(row, e.metaKey || e.ctrlKey);
      },
      onAuxClick: (e: React.MouseEvent<HTMLElement>) => {
        if (e.button !== 1 || isInteractiveTarget(e.target, e.currentTarget)) return;
        e.preventDefault();
        openRow(row, true);
      },
      onMouseEnter: () => {
        const href = rowHref?.(row);
        if (href) router.prefetch(href);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || (!rowHref && e.key === ' ')) {
          e.preventDefault();
          openRow(row, e.metaKey || e.ctrlKey);
        }
      },
    };
  }
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [globalFilter, setGlobalFilter] = useState('');

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnVisibility, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    // Con paginación en el servidor se ven todas las filas cargadas.
    initialState: { pagination: { pageSize: loadMore ? 100_000 : pageSize } },
  });

  return (
    <div className="space-y-3">
      {(searchPlaceholder || toolbarRight || serverSearch) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {serverSearch ? (
            <Input
              value={serverSearch.value}
              onChange={(e) => serverSearch.onChange(e.target.value)}
              placeholder={serverSearch.placeholder}
              className="max-w-sm"
            />
          ) : (
            searchPlaceholder && (
              <Input
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                className="max-w-sm"
              />
            )
          )}
          {toolbarRight && <div className="ml-auto flex items-center gap-2">{toolbarRight}</div>}
        </div>
      )}
      {/* Escritorio (md+): tabla. */}
      <div className="hidden rounded-md border md:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  return (
                    <TableHead
                      key={header.id}
                      className={canSort ? 'cursor-pointer select-none' : ''}
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          className="flex items-center gap-1"
                          onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {canSort ? (
                            header.column.getIsSorted() === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : header.column.getIsSorted() === 'desc' ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            )
                          ) : null}
                        </div>
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                  Cargando...
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                  {emptyText}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  {...rowProps(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Móvil (<md): cada fila como tarjeta clave/valor. Las tablas anchas no
          caben en un teléfono sin scroll horizontal; en su lugar apilamos las
          columnas (etiqueta = cabecera, valor = la misma celda que la tabla).
          Comparte el mismo `table`, así respeta búsqueda, orden y paginación. */}
      <div className="space-y-2 md:hidden">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Cargando...</p>
        ) : table.getRowModel().rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          table.getRowModel().rows.map((row) => (
            <div
              key={row.id}
              {...rowProps(row.original)}
              className={`rounded-md border p-3 ${
                clickable
                  ? 'relative cursor-pointer pr-8 transition-colors active:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  : ''
              }`}
            >
              {clickable && (
                <ChevronRight
                  className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
              )}
              <dl className="space-y-1.5 text-sm">
                {row
                  .getVisibleCells()
                  .filter((cell) => !cell.column.columnDef.meta?.mobileHidden)
                  .map((cell) => {
                    const header = cell.column.columnDef.header;
                    const label =
                      typeof header === 'string'
                        ? header
                        : (cell.column.columnDef.meta?.mobileLabel ?? '');
                    return (
                      <div key={cell.id} className="flex items-start justify-between gap-3">
                        {label ? <dt className="shrink-0 text-muted-foreground">{label}</dt> : null}
                        <dd className={label ? 'min-w-0 text-right' : 'min-w-0 flex-1'}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </dd>
                      </div>
                    );
                  })}
              </dl>
            </div>
          ))
        )}
      </div>
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {table.getRowModel().rows.length} de {table.getFilteredRowModel().rows.length} filas
            {' · '}
            Página {table.getState().pagination.pageIndex + 1} de {table.getPageCount()}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Siguiente
            </Button>
          </div>
        </div>
      )}
      {loadMore?.hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore.onLoadMore}
            disabled={loadMore.loading}
          >
            {loadMore.loading ? 'Cargando…' : 'Cargar más'}
          </Button>
        </div>
      )}
    </div>
  );
}
