import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import "./drawer-resize.css";

export type DrawerSizes = { inline?: number; block?: number };
type Axis = keyof DrawerSizes;

function measure(handle: HTMLDivElement) {
  const area = handle.parentElement!;
  const panel = handle.nextElementSibling!;
  const vertical = getComputedStyle(area).flexDirection !== "column";
  const dimension = vertical ? "width" : "height";
  const axis: Axis = vertical ? "inline" : "block";
  const total = area.getBoundingClientRect()[dimension];
  const min = Math.min(vertical ? 220 : 155, total * (vertical ? 0.40 : 0.38));
  const shellMin = Math.min(vertical ? 265 : 165, total * (vertical ? 0.45 : 0.42));
  const max = Math.min(total * (vertical ? 0.65 : 0.70), total - shellMin - handle.getBoundingClientRect()[dimension]);
  return { area, axis, vertical, min: Math.ceil(min), max: Math.max(Math.ceil(min), Math.floor(max)), size: Math.round(panel.getBoundingClientRect()[dimension]) };
}

export function DrawerResizeHandle({ sizes }: { sizes: RefObject<DrawerSizes> }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; axis: Axis; start: number; size: number } | null>(null);
  const [value, setValue] = useState({ vertical: true, min: 0, max: 100, size: 50 });

  useLayoutEffect(() => {
    const node = handle.current!;
    const geometry = () => {
      if (!node.isConnected || !node.nextElementSibling) return;
      const { area, axis, vertical, min, max, size } = measure(node);
      const preferred = sizes.current[axis];
      if (preferred !== undefined) {
        const basis = Math.max(min, Math.min(max, preferred)) + "px";
        if (area.style.getPropertyValue("--drawer-" + axis) !== basis)
          area.style.setProperty("--drawer-" + axis, basis);
      } else area.style.removeProperty("--drawer-" + axis);
      setValue((old) => old.vertical === vertical && old.size === size && old.min === min && old.max === max
        ? old : { vertical, min, max, size });
    };
    geometry();
    const observer = new ResizeObserver(geometry);
    observer.observe(node.parentElement!);
    observer.observe(node.nextElementSibling!);
    return () => observer.disconnect();
  }, [sizes]);

  function setSize(px?: number) {
    if (!handle.current) return;
    const { area, axis, min, max } = measure(handle.current);
    if (px === undefined) {
      delete sizes.current[axis];
      area.style.removeProperty("--drawer-" + axis);
    } else {
      const rounded = Math.round(Math.min(max, Math.max(min, px)));
      sizes.current[axis] = rounded;
      area.style.setProperty("--drawer-" + axis, rounded + "px");
    }
  }
  function finish(node: HTMLDivElement, id: number) {
    if (drag.current?.id !== id) return;
    drag.current = null;
    delete node.dataset.dragging;
    if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
  }
  return (
    <div ref={handle} className="drawer-resizer" role="separator" tabIndex={0}
      aria-label="Resize remote files panel" aria-controls="terminal-file-drawer"
      aria-orientation={value.vertical ? "vertical" : "horizontal"}
      aria-valuemin={value.min} aria-valuemax={value.max} aria-valuenow={value.size} aria-valuetext={value.size + " pixels"}
      title="Drag to resize · Double-click to reset"
      onDoubleClick={() => setSize()}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        const { axis, vertical, size } = measure(event.currentTarget);
        drag.current = { id: event.pointerId, axis, start: vertical ? event.clientX : event.clientY, size };
        event.currentTarget.dataset.dragging = "true";
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const { axis, vertical } = measure(event.currentTarget);
        if (axis !== current.axis) return finish(event.currentTarget, event.pointerId);
        const position = vertical ? event.clientX : event.clientY;
        setSize(current.size + current.start - position);
      }}
      onPointerUp={(event) => finish(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => finish(event.currentTarget, event.pointerId)}
      onLostPointerCapture={(event) => finish(event.currentTarget, event.pointerId)}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        const { vertical, size } = measure(event.currentTarget);
        const wider = vertical ? "ArrowLeft" : "ArrowUp";
        const narrower = vertical ? "ArrowRight" : "ArrowDown";
        if (!["Home", wider, narrower].includes(event.key)) return;
        event.preventDefault();
        setSize(event.key === "Home" ? undefined : size + (event.key === wider ? 16 : -16));
      }}
    />
  );
}
