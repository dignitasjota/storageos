import { type AiCompletion, type AiEffort, AiProvider, type AiRequest } from './ai-provider';
import { AnthropicAiProvider } from './anthropic-ai-provider';
import { type PlatformAiSettingsService } from './platform-ai-settings.service';
import { StubAiProvider } from './stub-ai-provider';

/**
 * El provider que usa la app: en cada llamada elige el real (con la clave y el
 * modelo del panel o de las variables) o el de demostración. Así cambiar la
 * clave en el panel admin no exige volver a desplegar. En los tests siempre
 * el de demostración (nunca sale a la red).
 */
export class DelegatingAiProvider extends AiProvider {
  private readonly stub = new StubAiProvider();
  private cached: { key: string; provider: AnthropicAiProvider } | null = null;
  /** Claves propias de los tenants (pocas; se reutilizan entre llamadas). */
  private readonly ownProviders = new Map<string, AnthropicAiProvider>();

  constructor(
    private readonly settings: PlatformAiSettingsService,
    private readonly testMode: boolean,
  ) {
    super();
  }

  private current(): AiProvider {
    if (this.testMode) return this.stub;
    const r = this.settings.resolved();
    if (!r.apiKey) return this.stub;
    const key = `${r.model}:${r.apiKey}`;
    if (this.cached?.key !== key) {
      this.cached = { key, provider: new AnthropicAiProvider(r.apiKey, r.model) };
    }
    return this.cached.provider;
  }

  override forKey(
    apiKey: string,
    model: string,
    maxTokens?: number,
    effort?: AiEffort,
  ): AiProvider {
    if (this.testMode) return this.stub;
    const key = `${model}:${maxTokens ?? ''}:${effort ?? ''}:${apiKey}`;
    let provider = this.ownProviders.get(key);
    if (!provider) {
      if (this.ownProviders.size >= 200) this.ownProviders.clear();
      provider = new AnthropicAiProvider(apiKey, model, maxTokens, effort);
      this.ownProviders.set(key, provider);
    }
    return provider;
  }

  override forModel(model: string, maxTokens?: number, effort?: AiEffort): AiProvider {
    if (this.testMode) return this.stub;
    const r = this.settings.resolved();
    if (!r.apiKey) return this.stub;
    const key = `${model}:${maxTokens ?? ''}:${effort ?? ''}:${r.apiKey}`;
    let provider = this.ownProviders.get(key);
    if (!provider) {
      if (this.ownProviders.size >= 200) this.ownProviders.clear();
      provider = new AnthropicAiProvider(r.apiKey, model, maxTokens, effort);
      this.ownProviders.set(key, provider);
    }
    return provider;
  }

  get available(): boolean {
    return this.current().available;
  }

  get modelName(): string {
    return this.current().modelName;
  }

  createMessage(args: AiRequest): Promise<AiCompletion> {
    return this.current().createMessage(args);
  }

  override streamMessage(args: AiRequest, onText: (delta: string) => void): Promise<AiCompletion> {
    return this.current().streamMessage(args, onText);
  }
}
