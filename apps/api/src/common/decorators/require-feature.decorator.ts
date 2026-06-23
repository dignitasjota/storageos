import { SetMetadata } from '@nestjs/common';

import type { TenantFeature } from '@storageos/shared';

export const FEATURE_KEY = 'requiredFeature';

/**
 * Marca un handler (o controller) como accesible solo si el **plan del tenant**
 * incluye la feature premium indicada. Se evalúa en `FeatureGuard`. El gating
 * por plan del frontend (`<FeatureGate>`) es cosmético; esto es la frontera real.
 *
 *   @RequireFeature('ai_assistant')
 */
export const RequireFeature = (feature: TenantFeature) => SetMetadata(FEATURE_KEY, feature);
