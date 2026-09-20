/**
 * Moved to `@ai-platform/shared` — docs/26_DECISIONS.md ADR-149.
 *
 * The trust boundary lived in `agent-core`, so the only subsystems that could reach it were the
 * ones that already depended on the agent. Long-term memory does not, and memory was the one
 * untrusted-text path in the platform with no wrapper at all — while landing in the `system`
 * role. A primitive every package needs belongs where every package can import it.
 *
 * Re-exported here so `@ai-platform/agent-core`'s public surface is unchanged.
 */
export { UNTRUSTED_CONTENT_SYSTEM_PROMPT, wrapUntrustedContent } from "@ai-platform/shared";
