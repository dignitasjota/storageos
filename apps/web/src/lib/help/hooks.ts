import { codeHelpTopicDtos, HELP_TOPICS, type HelpTopicDto } from '@storageos/shared';
import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth/api';

/** Las guías que vienen con la aplicación: lo que se enseña si el API falla. */
const FALLBACK: HelpTopicDto[] = codeHelpTopicDtos(HELP_TOPICS);

export const helpTopicsKey = ['help-topics'] as const;

/**
 * Guías de «Cómo funciona» (las del código con lo cambiado desde el panel
 * admin). Mientras carga o si falla, las del código.
 */
export function useHelpTopics(): { topics: HelpTopicDto[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: helpTopicsKey,
    queryFn: () => apiFetch<HelpTopicDto[]>('/help-topics'),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return { topics: query.data ?? FALLBACK, isLoading: query.isLoading };
}
