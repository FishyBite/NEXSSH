export type TabPlacement = "before" | "after";

export function reorderSessions<T extends { id: string }>(
  sessions: T[],
  sourceId: string,
  targetId: string,
  placement: TabPlacement,
): T[] {
  const source = sessions.findIndex((session) => session.id === sourceId);
  const target = sessions.findIndex((session) => session.id === targetId);
  if (source < 0 || target < 0 || source === target) return sessions;
  const insertion =
    target + (placement === "after" ? 1 : 0) - (source < target ? 1 : 0);
  if (insertion === source) return sessions;
  const ordered = [...sessions];
  const [moved] = ordered.splice(source, 1);
  ordered.splice(insertion, 0, moved);
  return ordered;
}

export function stableSessionOrder<T extends { id: string }>(
  previous: T[],
  current: T[],
): T[] {
  const byId = new Map(current.map((session) => [session.id, session]));
  const kept = previous.flatMap((session) => {
    const latest = byId.get(session.id);
    if (!latest) return [];
    byId.delete(session.id);
    return [latest];
  });
  return [...kept, ...byId.values()];
}

export function tabDropTarget(
  tabs: { id: string; left: number; right: number }[],
  sourceId: string,
  x: number,
): { targetId: string; placement: TabPlacement } | null {
  const target = tabs.find((tab) => x < tab.right) || tabs.at(-1);
  if (!target || target.id === sourceId) return null;
  return {
    targetId: target.id,
    placement: x < (target.left + target.right) / 2 ? "before" : "after",
  };
}

export function tabPreviewLayout(
  tabs: { id: string; left: number; width: number }[],
  sourceId: string,
  target: { targetId: string; placement: TabPlacement } | null,
  gap: number,
): { offsets: Map<string, number>; gapLeft: number } {
  const ordered = target
    ? reorderSessions(tabs, sourceId, target.targetId, target.placement)
    : tabs;
  let left = tabs[0]?.left ?? 0;
  let gapLeft = left;
  const offsets = new Map<string, number>();
  for (const tab of ordered) {
    offsets.set(tab.id, left - tab.left);
    if (tab.id === sourceId) gapLeft = left;
    left += tab.width + gap;
  }
  return { offsets, gapLeft };
}
