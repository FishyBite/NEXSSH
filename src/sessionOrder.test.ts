import { describe, expect, it } from "vitest";
import {
  reorderSessions,
  stableSessionOrder,
  tabDropTarget,
  tabPreviewLayout,
} from "./sessionOrder";

const sessions = ["a", "b", "c", "d"].map((id) => ({
  id,
  status: "connected",
}));
const ids = (items: typeof sessions) => items.map((item) => item.id);

describe("terminal tab order", () => {
  it("opens a correctly sized gap across unequal-width tabs in either direction", () => {
    const tabs = [
      { id: "a", left: 40, width: 150 },
      { id: "b", left: 191, width: 200 },
      { id: "c", left: 392, width: 170 },
    ];
    const right = tabPreviewLayout(
      tabs,
      "a",
      { targetId: "c", placement: "after" },
      1,
    );
    expect(right.gapLeft).toBe(412);
    expect([...right.offsets]).toEqual([
      ["b", -151],
      ["c", -151],
      ["a", 372],
    ]);
    const left = tabPreviewLayout(
      tabs,
      "c",
      { targetId: "a", placement: "before" },
      1,
    );
    expect(left.gapLeft).toBe(40);
    expect([...left.offsets]).toEqual([
      ["c", -352],
      ["a", 171],
      ["b", 171],
    ]);
    expect([...tabPreviewLayout(tabs, "a", null, 1).offsets.values()]).toEqual([
      0, 0, 0,
    ]);
  });
  it("moves in both directions without mutating sessions or replacing session objects", () => {
    const right = reorderSessions(sessions, "a", "c", "after");
    expect(ids(right)).toEqual(["b", "c", "a", "d"]);
    expect(ids(reorderSessions(right, "a", "b", "before"))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(ids(sessions)).toEqual(["a", "b", "c", "d"]);
    expect(right.every((item) => sessions.includes(item))).toBe(true);
  });

  it("ignores missing, identical and already-adjacent targets", () => {
    expect(reorderSessions(sessions, "closed", "b", "before")).toBe(sessions);
    expect(reorderSessions(sessions, "a", "closed", "after")).toBe(sessions);
    expect(reorderSessions(sessions, "a", "a", "after")).toBe(sessions);
    expect(reorderSessions(sessions, "b", "c", "before")).toBe(sessions);
    expect(reorderSessions(sessions, "c", "b", "after")).toBe(sessions);
  });

  it("moves filtered tabs relative to the target while keeping other groups in order", () => {
    const grouped = [
      { id: "a" },
      { id: "hidden-1" },
      { id: "b" },
      { id: "hidden-2" },
      { id: "c" },
    ];
    const ordered = reorderSessions(grouped, "a", "c", "after");
    expect(ordered.map((session) => session.id)).toEqual([
      "hidden-1",
      "b",
      "hidden-2",
      "c",
      "a",
    ]);
  });

  it("keeps split panes in their existing order while accepting new session metadata", () => {
    const renamed = { ...sessions[1], status: "disconnected" };
    const changed = [
      sessions[2],
      renamed,
      sessions[0],
      { id: "new", status: "connected" },
    ];
    const panes = stableSessionOrder(sessions, changed);
    expect(ids(panes)).toEqual(["a", "b", "c", "new"]);
    expect(panes[1]).toBe(renamed);
  });

  it("uses the hovered tab midpoint and ignores the dragged tab itself", () => {
    const bounds = [
      { id: "a", left: -40, right: 60 },
      { id: "b", left: 60, right: 160 },
      { id: "c", left: 160, right: 260 },
    ];
    expect(tabDropTarget(bounds, "a", 65)).toEqual({
      targetId: "b",
      placement: "before",
    });
    expect(tabDropTarget(bounds, "a", 155)).toEqual({
      targetId: "b",
      placement: "after",
    });
    expect(tabDropTarget(bounds, "b", 0)).toEqual({
      targetId: "a",
      placement: "before",
    });
    expect(tabDropTarget(bounds, "b", 110)).toBeNull();
    expect(tabDropTarget([], "b", 110)).toBeNull();
  });
});
