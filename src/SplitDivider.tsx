import { useRef } from "react";
import { splitRatio } from "./terminalLayout";

export function SplitDivider({ direction, ratio, onResize }: {
  direction: "vertical" | "horizontal"; ratio: number; onResize: (percent: number) => void;
}) {
  const pointer = useRef<number | null>(null);
  const vertical = direction === "vertical";
  return <div role="separator" aria-label="Resize session panes" tabIndex={0}
    aria-orientation={direction} aria-valuemin={20} aria-valuemax={80}
    aria-valuenow={Math.round(ratio)} title="Drag to resize · Double-click for equal panes"
    className="split-divider"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      pointer.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (pointer.current !== event.pointerId) return;
      const rect = event.currentTarget.parentElement!.getBoundingClientRect();
      const size = vertical ? rect.width : rect.height;
      if (size) onResize(splitRatio(100 * (vertical ? event.clientX - rect.left : event.clientY - rect.top) / size));
    }}
    onLostPointerCapture={() => { pointer.current = null; }}
    onDoubleClick={() => onResize(50)}
    onKeyDown={event => {
      const step = event.shiftKey ? 10 : 2;
      const values: Record<string, number> = { Home: 20, End: 80, Enter: 50,
        [vertical ? "ArrowLeft" : "ArrowUp"]: ratio - step, [vertical ? "ArrowRight" : "ArrowDown"]: ratio + step };
      if (!Object.hasOwn(values, event.key)) return;
      event.preventDefault();
      onResize(splitRatio(values[event.key]));
    }}
  />;
}
