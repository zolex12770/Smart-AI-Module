"use client";

import { useState } from "react";
import { assetUrl, getFile, ragQuery, type RagAnswer } from "../lib/api";
import { RequireSession } from "../lib/session-context";

/**
 * Ask a question over this project's documents — docs/26_DECISIONS.md ADR-076 (the endpoint),
 * ADR-084 (this screen).
 *
 * The whole ingestion half of RAG — upload, scan, parse, chunk, embed, index — had no way to be
 * QUERIED from the UI at all. Documents went in and nothing ever came out of them.
 *
 * The design decision that matters here is that a NOT-grounded answer is shown as such rather
 * than hidden. ADR-075 exists because a real model, asked a question with no retrieved passages,
 * invented a citation to a document that did not exist. The API now detects that and reports
 * `grounded: false`; silently swapping in the refusal text would reproduce the original bug with
 * better manners, because the user would have no way to tell "there was nothing to find" from
 * "the model went off-piste and we caught it".
 */

export default function AskPage() {
  return (
    <RequireSession>
      <AskView />
    </RequireSession>
  );
}

/**
 * Resolves the `documents` row ids a citation carries to the asset ids the bytes live under.
 *
 * `sources[].documentId` is a row in `documents`; `GET /api/v1/assets/:id` looks up a row in
 * `assets`. They are different tables with different ids, so linking a citation straight at
 * `assetUrl(source.documentId)` produced a 404 on every single source — a citation that looks
 * followable and is not, which docs/09 §6 counts as worse than no link at all.
 *
 * `GET /api/v1/files/:id` is the endpoint that actually resolves one: it returns the document
 * record, whose `assetId` is the id the asset route understands. A document ingested from a
 * sandbox path (rather than uploaded) has no asset at all and its `assetId` is null — there
 * are no bytes to serve, so that citation stays plain text rather than pointing at a 404.
 * A failed lookup maps to null for the same reason.
 */
async function resolveSourceAssets(documentIds: string[]): Promise<Record<string, string | null>> {
  const distinct = [...new Set(documentIds)];
  const entries = await Promise.all(
    distinct.map(async (documentId) => {
      try {
        const { document } = await getFile(documentId);
        return [documentId, document.assetId] as const;
      } catch {
        return [documentId, null] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

function AskView() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [sourceAssets, setSourceAssets] = useState<Record<string, string | null>>({});
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    setSourceAssets({});
    try {
      const result = await ragQuery(trimmed);
      setAnswer(result);
      // Deliberately not awaited: the answer is what the user asked for, and a slow document
      // lookup must not hold it back. Until this resolves every citation renders as plain
      // text, which is the correct intermediate state rather than a link that 404s.
      // `resolveSourceAssets` catches per-document, so this can never reject.
      void resolveSourceAssets(result.sources.map((s) => s.documentId)).then(setSourceAssets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }

  return (
    <section>
      <h1>Ask your documents</h1>
      <p className="page-subtitle">
        Answers come only from files you have uploaded, with the passages they came from. If nothing in
        your documents answers the question, you will be told that rather than given a guess.
      </p>

      <form onSubmit={handleAsk} style={{ display: "grid", gap: 8, maxWidth: 760, margin: "16px 0" }}>
        <label htmlFor="rag-question">Question</label>
        <textarea
          id="rag-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="e.g. What is the rollback procedure for the payments service?"
        />
        <button type="submit" className="btn" disabled={asking || question.trim() === ""}>
          {asking ? "Searching…" : "Ask"}
        </button>
      </form>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      {answer ? (
        <>
          <h2>Answer</h2>
          {answer.grounded === false ? (
            /*
             * Shown, not swallowed. The API caught the model citing a source it was never given
             * (ADR-075); hiding that would leave the user unable to distinguish it from an honest
             * "no documents matched", which is a different situation with a different remedy.
             */
            <p className="auth-error" role="alert">
              The model produced an answer that was not supported by your documents, so it was
              rejected. {answer.groundingReason ?? ""}
            </p>
          ) : null}

          <p style={{ whiteSpace: "pre-wrap" }}>{answer.answer}</p>

          <h2>Sources</h2>
          {answer.sources.length === 0 ? (
            <p>No passages matched closely enough to be used as evidence.</p>
          ) : (
            <ul>
              {answer.sources.map((source) => {
                // Resolved from the document id via `GET /api/v1/files/:id` (see
                // `resolveSourceAssets`). Undefined while that is still in flight, null when
                // the document has no stored bytes — both render as plain text, because a
                // citation that cannot be followed is not a citation (docs/09 §6) and a link
                // that 404s is exactly that.
                const assetId = sourceAssets[source.documentId];
                return (
                  <li key={`${source.documentId}:${source.chunkIndex}`} style={{ marginBottom: 12 }}>
                    <strong>{source.marker}</strong>{" "}
                    {assetId ? (
                      <a href={assetUrl(assetId)} target="_blank" rel="noreferrer">
                        {source.filename}
                      </a>
                    ) : (
                      <span>{source.filename}</span>
                    )}{" "}
                    <span className="page-subtitle">
                      (chunk {source.chunkIndex}, distance {source.distance})
                    </span>
                    <blockquote style={{ margin: "6px 0 0", opacity: 0.85 }}>{source.excerpt}</blockquote>
                  </li>
                );
              })}
            </ul>
          )}

          {answer.model ? (
            // Which model answered, on the page. Stated because the platform can be running a
            // self-hosted model, a hosted one, or a mock, and those are not interchangeable.
            <p className="page-subtitle">
              Answered by {answer.provider} / {answer.model}.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
