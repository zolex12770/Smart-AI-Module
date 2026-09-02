const SUCCESS = new Set(["succeeded", "completed", "ready", "COMPLETED"]);
const DANGER = new Set(["failed", "FAILED", "dead_letter", "CANCELLED", "cancelled"]);
const WARNING = new Set([
  "processing",
  "pending",
  "generating_scenes",
  "assembling",
  "ingesting",
  "partially_succeeded",
  "WAITING_FOR_APPROVAL",
  "PAUSED",
  "RETRYING",
  "waiting_approval",
  "needs_reconciliation",
]);

export function badgeClass(status: string): string {
  if (SUCCESS.has(status)) return "badge badge-success";
  if (DANGER.has(status)) return "badge badge-danger";
  if (WARNING.has(status)) return "badge badge-warning";
  return "badge badge-muted";
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={badgeClass(status)}>{status}</span>;
}
