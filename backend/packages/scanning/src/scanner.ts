/**
 * The malware-scanning boundary (docs/13_SECURITY_ARCHITECTURE.md §12, docs/26_DECISIONS.md
 * ADR-042). One real implementation today — `ClamAvScanner`, clamd's INSTREAM protocol — but
 * the job logic in backend/packages/rag depends only on this interface, so a managed scanning
 * service later is an adapter, not a rewrite (the same seam pattern as LLMProvider,
 * AssetStore, and every other provider boundary in this platform).
 */
export type ScanVerdict = { verdict: "clean" } | { verdict: "infected"; signature: string };

export interface MalwareScanner {
  /** A human-readable identifier for logs and the document's audit trail. */
  readonly name: string;
  /** Scans the given bytes. Resolves with a verdict; REJECTS (throws) if the scanner cannot
   * be reached or errors — a scan that could not run is never reported as clean. */
  scan(bytes: Buffer): Promise<ScanVerdict>;
  /** Liveness check, used at boot to warn early rather than at the first upload. */
  ping(): Promise<boolean>;
}
