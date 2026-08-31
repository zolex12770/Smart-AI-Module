import type { LLMProvider } from "@ai-platform/shared";

/**
 * Minimal Phase 1 registry — docs/12_MODEL_ROUTING.md's full CapabilityRegistry
 * (cost/quality/speed/context-length metadata per model) lands in Phase 2 once
 * real provider adapters exist. This is deliberately small: register providers,
 * look them up by name, know the default.
 */
export class ModelRegistry {
  private readonly providers = new Map<string, LLMProvider>();
  private defaultProviderName: string | undefined;

  register(provider: LLMProvider, opts: { asDefault?: boolean } = {}): void {
    this.providers.set(provider.name, provider);
    if (opts.asDefault || !this.defaultProviderName) {
      this.defaultProviderName = provider.name;
    }
  }

  get(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  getDefault(): LLMProvider {
    if (!this.defaultProviderName) {
      throw new Error("No LLM provider registered.");
    }
    const provider = this.providers.get(this.defaultProviderName);
    if (!provider) {
      throw new Error(`Default provider "${this.defaultProviderName}" is not registered.`);
    }
    return provider;
  }

  list(): LLMProvider[] {
    return [...this.providers.values()];
  }
}
