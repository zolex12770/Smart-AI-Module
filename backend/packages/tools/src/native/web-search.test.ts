import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry.js";
import { createWebSearchTools, MockSearchProvider } from "./web-search.js";

const dummyContext = { signal: undefined } as any;

describe("web.search tool", () => {
  it("registers into ToolRegistry with valid definition and permissions", () => {
    const registry = new ToolRegistry();
    const tools = createWebSearchTools();
    expect(tools.length).toBe(1);

    const [tool] = tools;
    expect(tool.definition.id).toBe("web.search");
    expect(tool.definition.permissionLevel).toBe("network");

    registry.register(tool.definition, tool.handler);
    const registered = registry.get("web.search");
    expect(registered).toBeDefined();
    expect(registered?.id).toBe("web.search");
  });

  it("returns search results for a query using MockSearchProvider", async () => {
    const tools = createWebSearchTools();
    const [tool] = tools;

    const result = await tool.handler({ query: "Fastify architecture" }, dummyContext);
    expect(result.ok).toBe(true);

    const output = result.output as {
      query: string;
      provider: string;
      count: number;
      results: Array<{ title: string; url: string; snippet: string }>;
    };

    expect(output.query).toBe("Fastify architecture");
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results[0].title).toContain("Fastify architecture");
    expect(output.results[0].url).toMatch(/^https:\/\//);
    expect(output.results[0].snippet).toBeDefined();
  });

  it("applies limit parameter accurately", async () => {
    const tools = createWebSearchTools();
    const [tool] = tools;

    const result = await tool.handler({ query: "vitest testing", limit: 2 }, dummyContext);
    expect(result.ok).toBe(true);
    const output = result.output as { results: unknown[] };
    expect(output.results.length).toBe(2);
  });

  it("filters by domain when domainFilter is provided", async () => {
    const customProvider = new MockSearchProvider({
      react: [
        { title: "React Docs", url: "https://react.dev/learn", snippet: "React tutorial" },
        { title: "GitHub Repo", url: "https://github.com/facebook/react", snippet: "Source code" },
      ],
    });

    const tools = createWebSearchTools({ provider: customProvider });
    const [tool] = tools;

    const result = await tool.handler({ query: "react", domainFilter: "github.com" }, dummyContext);
    expect(result.ok).toBe(true);
    const output = result.output as { results: Array<{ url: string }> };
    expect(output.results.length).toBe(1);
    expect(output.results[0].url).toContain("github.com");
  });

  it("refuses an empty query cleanly without throwing an exception", async () => {
    const tools = createWebSearchTools();
    const [tool] = tools;

    const result = await tool.handler({ query: "   " }, dummyContext);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Search query cannot be empty");
  });
});
