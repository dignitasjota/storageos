import { Suspense } from 'react';

import { HelpIntro } from './help-intro';
import { HelpTopics } from './help-topics';

export const metadata = { title: 'Cómo funciona' };

export default function HelpPage() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cómo funciona</h1>
        <HelpIntro />
      </div>
      {/* La búsqueda se lee de la dirección (`?q=`). */}
      <Suspense fallback={null}>
        <HelpTopics />
      </Suspense>
    </div>
  );
}
