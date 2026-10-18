'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

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
import { Label } from '@/components/ui/label';

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  /** Botón rojo (borrar, devolver, limpiar…). */
  destructive?: boolean;
  /** Pide además un texto opcional (p. ej. el motivo). */
  input?: { label: string; placeholder?: string };
}

/** `false` si se cancela; si no, `{ value }` con el texto escrito (o ''). */
type ConfirmResult = false | { value: string };

type ConfirmFn = (options: ConfirmOptions) => Promise<ConfirmResult>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Diálogo de confirmación del panel admin (sustituye a `window.confirm` y
 * `window.prompt`, que el navegador puede bloquear y no siguen el tema).
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [value, setValue] = useState('');
  const resolver = useRef<((r: ConfirmResult) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts);
    setValue('');
    return new Promise<ConfirmResult>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  function close(result: ConfirmResult) {
    resolver.current?.(result);
    resolver.current = null;
    setOptions(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={options !== null} onOpenChange={(open) => !open && close(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{options?.title}</DialogTitle>
            {options?.description && <DialogDescription>{options.description}</DialogDescription>}
          </DialogHeader>
          {options?.input && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm-input">{options.input.label}</Label>
              <Input
                id="confirm-input"
                value={value}
                placeholder={options.input.placeholder}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              Cancelar
            </Button>
            <Button
              variant={options?.destructive ? 'destructive' : 'default'}
              onClick={() => close({ value: value.trim() })}
            >
              {options?.confirmLabel ?? 'Confirmar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Confirmación con diálogo propio: `if (!(await confirm({...}))) return;` */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm fuera de <ConfirmProvider>');
  return fn;
}
