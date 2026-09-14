import { describe, expect, it, vi } from "vitest";
import { detectLocalRuntime, pickChatModel } from "./local-runtime.js";

/**
 * Adopting the model runtime already running on this machine — docs/26_DECISIONS.md ADR-118.
 *
 * With no `.env`, the platform answered chat from the MOCK and ranked retrieval with the lexical
 * hash embedder while Ollama served a real chat model and a real embedding model on 127.0.0.1.
 * These pin the three properties that make detection safe: explicit configuration wins, production
 * never probes, and anything unexpected leaves the platform exactly where it was.
 */
const logger = () => ({ info: vi.fn(), warn: vi.fn() });

const tags = (names: string[]) =>
  vi.fn(async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 }));

describe("detectLocalRuntime", () => {
  it("adopts a running runtime, choosing a chat model and an embedding model", async () => {
    const log = logger();
    const detected = await detectLocalRuntime(
      { NODE_ENV: "development" },
      log,
      { baseUrl: "http://127.0.0.1:11434", fetchImpl: tags(["nomic-embed-text:latest", "qwen2.5:7b"]) as unknown as typeof fetch }
    );

    expect(detected).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      chatModel: "qwen2.5:7b",
      embeddingModel: "nomic-embed-text:latest",
      runtime: "ollama",
    });
    // It says so at boot — silent adoption is how a surprise becomes a mystery.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ chat_model: "qwen2.5:7b" }),
      expect.stringContaining("local model runtime detected")
    );
  });

  it("never probes when a runtime was configured explicitly", async () => {
    const fetchImpl = tags(["qwen2.5:7b"]);
    const detected = await detectLocalRuntime(
      { NODE_ENV: "development", LLM_BASE_URL: "http://gateway:8000/v1", LLM_MODEL: "mixtral" },
      logger(),
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(detected).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never probes in production, where what answers users is an explicit decision", async () => {
    const fetchImpl = tags(["qwen2.5:7b"]);
    const detected = await detectLocalRuntime({ NODE_ENV: "production" }, logger(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(detected).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("declines, with a reason, when the runtime has only embedding models pulled", async () => {
    const log = logger();
    const detected = await detectLocalRuntime({ NODE_ENV: "development" }, log, {
      fetchImpl: tags(["nomic-embed-text:latest"]) as unknown as typeof fetch,
    });
    expect(detected).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("no chat model pulled"));
  });

  it("treats an unreachable runtime as nothing to adopt, not as an error", async () => {
    const log = logger();
    const detected = await detectLocalRuntime({ NODE_ENV: "development" }, log, {
      fetchImpl: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      }) as unknown as typeof fetch,
    });
    expect(detected).toBeNull();
    expect(log.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("no local model runtime detected"));
  });

  it("declines when the runtime answers with an error status", async () => {
    const detected = await detectLocalRuntime({ NODE_ENV: "development" }, logger(), {
      fetchImpl: vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(detected).toBeNull();
  });

  it("gives up rather than hanging a boot on a slow runtime", async () => {
    const log = logger();
    const started = Date.now();
    const detected = await detectLocalRuntime({ NODE_ENV: "development" }, log, {
      timeoutMs: 100,
      fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    expect(detected).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("accepts OLLAMA_HOST with or without a scheme", async () => {
    const fetchImpl = tags(["qwen2.5:7b"]);
    process.env.OLLAMA_HOST = "10.0.0.5:11434";
    try {
      const detected = await detectLocalRuntime({ NODE_ENV: "development" }, logger(), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(detected?.baseUrl).toBe("http://10.0.0.5:11434/v1");
      expect(String(fetchImpl.mock.calls[0][0])).toBe("http://10.0.0.5:11434/api/tags");
    } finally {
      delete process.env.OLLAMA_HOST;
    }
  });
});

describe("pickChatModel", () => {
  it("prefers a tool-capable instruct model over whatever happens to be first", () => {
    expect(pickChatModel(["llama3:8b", "qwen2.5:7b"])).toBe("qwen2.5:7b");
    expect(pickChatModel(["gemma:2b", "mistral:7b"])).toBe("mistral:7b");
  });

  it("never returns an embedding model", () => {
    expect(pickChatModel(["nomic-embed-text:latest", "mxbai-embed-large"])).toBeUndefined();
    expect(pickChatModel(["nomic-embed-text:latest", "tinyllama"])).toBe("tinyllama");
  });

  it("falls back to whatever is pulled when nothing is recognised", () => {
    expect(pickChatModel(["some-unknown-model:latest"])).toBe("some-unknown-model:latest");
    expect(pickChatModel([])).toBeUndefined();
  });
});
