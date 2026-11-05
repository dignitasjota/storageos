import Link from 'next/link';

import { HelpTopics } from './help-topics';

export const metadata = { title: 'Cómo funciona' };

export default function HelpPage() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cómo funciona</h1>
        <p className="text-sm text-muted-foreground">
          El día a día con TrasterOS: qué pasa solo y qué haces tú. Para empezar, revisa la{' '}
          <Link href="/settings/getting-started" className="text-primary hover:underline">
            puesta en marcha
          </Link>
          ; si algo no queda claro,{' '}
          <Link href="/support" className="text-primary hover:underline">
            escríbenos
          </Link>
          .
        </p>
      </div>
      <HelpTopics />
    </div>
  );
}
