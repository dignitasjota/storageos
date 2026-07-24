'use client';

import { useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Formulario de contacto de la web pública → crea un lead (Web Premium). */
export function ContactForm({ slug, brand }: { slug: string; brand: string }) {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: fd.get('firstName'),
          email: fd.get('email'),
          phone: fd.get('phone') || '',
          message: fd.get('message') || '',
          hp: fd.get('company') || '', // honeypot
        }),
      });
      if (!res.ok) throw new Error('fail');
      setSent(true);
    } catch {
      setError('No se pudo enviar. Inténtalo de nuevo o llámanos.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <p className="rounded-md border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
        ¡Gracias! Hemos recibido tu mensaje y te contactaremos pronto.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto grid max-w-lg gap-3">
      {/* Honeypot: oculto para humanos, los bots lo rellenan */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0"
      />
      <input
        name="firstName"
        required
        placeholder="Tu nombre"
        className="h-11 rounded-md border bg-background px-3 text-base"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          name="email"
          type="email"
          required
          placeholder="Email"
          className="h-11 rounded-md border bg-background px-3 text-base"
        />
        <input
          name="phone"
          type="tel"
          placeholder="Teléfono (opcional)"
          className="h-11 rounded-md border bg-background px-3 text-base"
        />
      </div>
      <textarea
        name="message"
        rows={4}
        placeholder="¿En qué podemos ayudarte?"
        className="rounded-md border bg-background px-3 py-2 text-base"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="h-11 rounded-md px-6 text-sm font-medium text-white shadow transition-opacity hover:opacity-90 disabled:opacity-60"
        style={{ backgroundColor: brand }}
      >
        {loading ? 'Enviando…' : 'Enviar mensaje'}
      </button>
    </form>
  );
}
