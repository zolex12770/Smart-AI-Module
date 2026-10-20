import { PERMISSION_LEVEL_DEFAULTS, type ToolDefinition } from "@ai-platform/shared";
import type { NativeToolEntry } from "./filesystem.js";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  name: string;
  search(
    query: string,
    options?: { limit?: number; domainFilter?: string; signal?: AbortSignal }
  ): Promise<SearchResultItem[]>;
}

export interface WebSearchOptions {
  provider?: SearchProvider;
  defaultLimit?: number;
}

/**
 * Deterministic Mock Search Provider for testing and offline environments.
 */
export class MockSearchProvider implements SearchProvider {
  name = "mock";

  constructor(private customResults?: Record<string, SearchResultItem[]>) {}

  async search(
    query: string,
    options?: { limit?: number; domainFilter?: string }
  ): Promise<SearchResultItem[]> {
    const limit = options?.limit ?? 5;
    const lowerQuery = query.toLowerCase();

    let matchingResults: SearchResultItem[] = [
      {
        title: `${query} - Official Documentation & Guide`,
        url: `https://docs.example.org/${encodeURIComponent(query.replace(/\s+/g, "-"))}`,
        snippet: `Comprehensive technical documentation, API references, and architecture details for ${query}.`,
      },
      {
        title: `Understanding ${query}: Principles & Best Practices`,
        url: `https://developer.example.com/articles/${encodeURIComponent(query.replace(/\s+/g, "-"))}`,
        snippet: `In-depth analysis, benchmark comparisons, and security considerations related to ${query}.`,
      },
      {
        title: `${query} Open Source Project Repository`,
        url: `https://github.com/example-org/${encodeURIComponent(query.replace(/\s+/g, "-"))}`,
        snippet: `Open source repository with releases, test suites, and implementation code for ${query}.`,
      },
    ];

    if (this.customResults) {
      for (const [key, results] of Object.entries(this.customResults)) {
        if (lowerQuery.includes(key.toLowerCase())) {
          matchingResults = results;
          break;
        }
      }
    }

    if (options?.domainFilter) {
      const domain = options.domainFilter.toLowerCase();
      matchingResults = matchingResults.filter((r) => r.url.toLowerCase().includes(domain));
    }

    return matchingResults.slice(0, limit);
  }
}

/**
 * Brave Search API Provider.
 * Activates when BRAVE_SEARCH_API_KEY is present in environment.
 */
export class BraveSearchProvider implements SearchProvider {
  name = "brave";

  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {}

  async search(
    query: string,
    options?: { limit?: number; domainFilter?: string; signal?: AbortSignal }
  ): Promise<SearchResultItem[]> {
    const limit = options?.limit ?? 5;
    let finalQuery = query;
    if (options?.domainFilter) {
      finalQuery += ` site:${options.domainFilter}`;
    }

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", finalQuery);
    url.searchParams.set("count", String(Math.min(limit, 20)));

    const response = await this.fetchImpl(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`Brave search API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    return (data.web?.results ?? []).map((item) => ({
      title: item.title ?? "Untitled",
      url: item.url ?? "",
      snippet: item.description ?? "",
    }));
  }
}

/**
 * Creates the `web.search` tool.
 */
export function createWebSearchTools(options: WebSearchOptions = {}): NativeToolEntry[] {
  const defaults = PERMISSION_LEVEL_DEFAULTS.network;
  const apiKey = process.env.BRAVE_SEARCH_API_KEY || process.env.SEARCH_API_KEY;
  const provider = options.provider ?? (apiKey ? new BraveSearchProvider(apiKey) : new MockSearchProvider());

  const definition: ToolDefinition = {
    id: "web.search",
    name: "Search the web",
    description:
      "Search the web for up-to-date information, documentation, articles, and references. Returns a structured list of ranked results with titles, URLs, and snippets.",
    origin: { kind: "native", serverId: null, serverVersion: null },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search terms or question to look up.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of search results to return (default 5).",
        },
        domainFilter: {
          type: "string",
          description: "Optional domain filter (e.g. 'github.com' or 'docs.python.org').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: null,
    permissionLevel: "network",
    riskLevel: defaults.riskLevel,
    requiresApproval: defaults.requiresApproval,
    timeoutMs: defaults.timeoutMs,
    retryPolicy: { maxAttempts: defaults.maxAttempts, backoff: "exponential", idempotencyRequired: false },
    enabled: true,
  };

  return [
    {
      definition,
      handler: async (args, context) => {
        try {
          const query = String(args.query).trim();
          if (!query) {
            return { ok: false, error: "Search query cannot be empty" };
          }

          const limit = args.limit !== undefined ? Number(args.limit) : (options.defaultLimit ?? 5);
          const domainFilter = args.domainFilter ? String(args.domainFilter).trim() : undefined;

          const results = await provider.search(query, {
            limit,
            domainFilter,
            signal: context?.signal,
          });

          return {
            ok: true,
            output: {
              query,
              provider: provider.name,
              count: results.length,
              results,
            },
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
