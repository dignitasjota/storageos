'use client';

import { CircleHelp } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { guideForPath, helpHrefForPath } from '@/lib/help/route-guides';

/** «¿Cómo funciona esto?»: la guía de la pantalla actual (o «Cómo funciona»). */
export function HelpButton() {
  const pathname = usePathname();
  const label = guideForPath(pathname)
    ? '¿Cómo funciona esto? Ver la guía de esta pantalla'
    : '¿Cómo funciona esto? Ver las guías';
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link href={helpHrefForPath(pathname)} aria-label={label} title={label}>
        <CircleHelp className="size-5" aria-hidden />
      </Link>
    </Button>
  );
}
