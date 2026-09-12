import type { LLMProvider, ProviderCapabilities } from "@ai-platform/shared";

/**
 * Capability registry — docs/12_MODEL_ROUTING.md §2, built for real by ADR-058.
 *
 * The previous registry was a bare `Map` with a "default", which meant routing could only
 * ever mean "the first one registered". Selection now uses declared capability and cost, so
 * a request that needs tool calling is never sent to a model that cannot do it, and a cheap
 * model can serve cheap work without a caller naming it.
 */
export interface ModelDescriptor {
  provider: LLMProvider;
  capabilities: ProviderCapabilities;
  /** Relative cost per 1M input tokens; used only for ordering, never billed from. */
  costHint: number;
  /** Subjective quality tier, 1 (fastest/cheapest) to 5 (strongest). */
  qualityTier: number;
  /** Lower is faster. Used to break ties for latency-sensitive work. */
  latencyHint: number;
}

export interface SelectionCriteria {
  /** Only consider providers that can call tools. */
  requiresTools?: boolean;
  requiresVision?: boolean;
  /** Minimum context window in tokens. Providers reporting null are assumed sufficient. */
  minContextWindow?: number;
  /** What matters most for this request. */
  prefer?: "quality" | "cost" | "latency";
  /** Never select a mock, whatever else is true. */
  excludeMocks?: boolean;
}

export class ModelRegistry {
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private defaultProviderName: string | undefined;

  register(
    provider: LLMProvider,
    opts: { asDefault?: boolean; costHint?: number; qualityTier?: number; latencyHint?: number } = {}
  ): void {
    this.descriptors.set(provider.name, {
      provider,
      capabilities: provider.capabilities(),
      costHint: opts.costHint ?? 1,
      qualityTier: opts.qualityTier ?? 3,
      latencyHint: opts.latencyHint ?? 1,
    });
    if (opts.asDefault || !this.defaultProviderName) {
      this.defaultProviderName = provider.name;
    }
  }

  get(name: string): LLMProvider | undefined {
    return this.descriptors.get(name)?.provider;
  }

  describe(name: string): ModelDescriptor | undefined {
    return this.descriptors.get(name);
  }

  getDefault(): LLMProvider {
    if (!this.defaultProviderName) throw new Error("No LLM provider registered.");
    const descriptor = this.descriptors.get(this.defaultProviderName);
    if (!descriptor) throw new Error(`Default provider "${this.defaultProviderName}" is not registered.`);
    return descriptor.provider;
  }

  list(): LLMProvider[] {
    return [...this.descriptors.values()].map((d) => d.provider);
  }

  listDescriptors(): ModelDescriptor[] {
    return [...this.descriptors.values()];
  }

  /**
   * Ordered candidates for a request. Hard requirements filter; preferences sort. Returning
   * an ordered list rather than one choice is what makes fallback a routing outcome instead
   * of a retry hack (docs/12 §4.2).
   */
  select(criteria: SelectionCriteria = {}): LLMProvider[] {
    const eligible = this.listDescriptors().filter((d) => {
      if (criteria.excludeMocks && d.provider.isMock) return false;
      if (criteria.requiresTools && !d.capabilities.toolCalling) return false;
      if (criteria.requiresVision && !d.capabilities.vision) return false;
      if (
        criteria.minContextWindow &&
        d.capabilities.contextWindow !== null &&
        d.capabilities.contextWindow < criteria.minContextWindow
      ) {
        return false;
      }
      return true;
    });

    const prefer = criteria.prefer ?? "quality";
    const sorted = [...eligible].sort((a, b) => {
      // The configured default always leads when it survives the filters: an operator's
      // explicit choice outranks a heuristic.
      if (a.provider.name === this.defaultProviderName) return -1;
      if (b.provider.name === this.defaultProviderName) return 1;
      if (prefer === "cost") return a.costHint - b.costHint || b.qualityTier - a.qualityTier;
      if (prefer === "latency") return a.latencyHint - b.latencyHint || a.costHint - b.costHint;
      return b.qualityTier - a.qualityTier || a.costHint - b.costHint;
    });

    // A real provider always precedes a mock, whatever the ordering above produced.
    return [...sorted.filter((d) => !d.provider.isMock), ...sorted.filter((d) => d.provider.isMock)].map(
      (d) => d.provider
    );
  }
}
