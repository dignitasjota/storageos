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
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
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
}: DataTableProps<TData, TValue>) {
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
    initialState: { pagination: { pageSize } },
  });

  return (
    <div className="space-y-3">
      {(searchPlaceholder || toolbarRight) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {searchPlaceholder && (
            <Input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={searchPlaceholder}
              className="max-w-sm"
            />
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
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
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
            <div key={row.id} className="rounded-md border p-3">
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
    </div>
  );
}
