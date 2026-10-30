export type RoadmapAuditItem = { id: string; status: 'complete' | 'deferred' | 'blocked'; codeEvidence: readonly string[]; testEvidence: readonly string[]; deviceEvidence: readonly string[]; note?: string };
export type RoadmapAuditResult = { auditable: boolean; reasons: string[] };

/** Checks audit evidence shape; it does not claim that external/device evidence exists. */
export function validateRoadmapAudit(items: readonly RoadmapAuditItem[], expectedIds: readonly string[]): RoadmapAuditResult {
  const reasons: string[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const id of expectedIds) {
    const item = byId.get(id);
    if (!item) { reasons.push(`missing:${id}`); continue; }
    if (item.status === 'complete' && (item.codeEvidence.length === 0 || item.testEvidence.length === 0 || item.deviceEvidence.length === 0)) reasons.push(`complete_without_evidence:${id}`);
    if ((item.status === 'deferred' || item.status === 'blocked') && !item.note?.trim()) reasons.push(`deferred_without_note:${id}`);
  }
  if (items.some((item) => !expectedIds.includes(item.id))) reasons.push('unexpected_task');
  return { auditable: reasons.length === 0, reasons };
}
