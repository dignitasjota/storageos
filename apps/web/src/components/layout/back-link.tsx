import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

/** «← Inquilinos»: vuelta a la lista, siempre arriba a la izquierda. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2">
      <Link href={href}>
        <ArrowLeft className="mr-1 h-4 w-4" /> {label}
      </Link>
    </Button>
  );
}
