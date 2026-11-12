'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Barra fija abajo en el móvil con «Probar gratis» y «Demo». Aparece al bajar
 * un poco (no tapa la portada) y se esconde al llegar al formulario de demo.
 */
export function StickyMobileCta() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const demo = document.getElementById('demo');
      const atDemo = demo
        ? demo.getBoundingClientRect().top < window.innerHeight &&
          demo.getBoundingClientRect().bottom > 0
        : false;
      setVisible(window.scrollY > 500 && !atDemo);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div
      className={`pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur transition-transform duration-200 md:hidden ${visible ? 'translate-y-0' : 'translate-y-full'}`}
      aria-hidden={!visible}
    >
      <div className="flex gap-2 pb-3">
        <Button asChild className="flex-1" tabIndex={visible ? 0 : -1}>
          <Link href="/register">Probar gratis</Link>
        </Button>
        <Button asChild variant="outline" className="flex-1" tabIndex={visible ? 0 : -1}>
          <Link href="#demo">Pedir demo</Link>
        </Button>
      </div>
    </div>
  );
}
