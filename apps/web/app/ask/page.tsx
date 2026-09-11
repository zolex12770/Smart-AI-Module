"use client";

import { useState } from "react";
import { assetUrl, ragQuery, type RagAnswer } from "../lib/api";
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

function AskView() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<RagAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await ragQuery(trimmed));
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
              {answer.sources.map((source) => (
                <li key={`${source.documentId}:${source.chunkIndex}`} style={{ marginBottom: 12 }}>
                  <strong>{source.marker}</strong>{" "}
                  {/* A citation that cannot be followed is not a citation (docs/09 §6), so the
                      filename links to the stored document itself. */}
                  <a href={assetUrl(source.documentId)} target="_blank" rel="noreferrer">
                    {source.filename}
                  </a>{" "}
                  <span className="page-subtitle">
                    (chunk {source.chunkIndex}, distance {source.distance})
                  </span>
                  <blockquote style={{ margin: "6px 0 0", opacity: 0.85 }}>{source.excerpt}</blockquote>
                </li>
              ))}
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
