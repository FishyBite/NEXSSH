type Region = {
  element: HTMLElement;
  geometry: number[];
  path?: string;
};
type Layout = {
  viewport: number[];
  regions: Region[];
  overlays: Element[];
};

export function remoteDropPathBar(hit: Element | null) {
  return hit?.closest("button") ? null : hit?.closest<HTMLElement>('[data-file-drop-path="remote"]');
}

function currentLayout(list: HTMLElement | null, rows: string): Layout | null {
  if (!list?.isConnected) return null;
  const elements: HTMLElement[] = Array.from(
    list.querySelectorAll<HTMLElement>(rows),
  );
  const pathBar = list.closest('[data-file-side],.terminal-file-drawer')?.querySelector<HTMLElement>('[data-file-drop-path="remote"]');
  if (pathBar) elements.push(pathBar, ...pathBar.querySelectorAll<HTMLElement>("button,input"));
  for (
    let ancestor: HTMLElement | null = list;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    elements.push(ancestor);
  }
  const viewport = window.visualViewport;
  return {
    viewport: [
      innerWidth,
      innerHeight,
      scrollX,
      scrollY,
      devicePixelRatio,
      viewport?.offsetLeft || 0,
      viewport?.offsetTop || 0,
      viewport?.width || 0,
      viewport?.height || 0,
      viewport?.scale || 1,
    ],
    regions: elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        element,
        path: element.dataset.filePath || element.dataset.drawerDirectory,
        geometry: [
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          element.scrollLeft,
          element.scrollTop,
        ],
      };
    }),
    overlays: Array.from(
      document.querySelectorAll(
        '[role="dialog"],[role="menu"],.file-log-panel',
      ),
    ),
  };
}

export function captureNativeFileDropLayout(
  list = document.querySelector<HTMLElement>('[data-file-drop-list="remote"]'),
  rows = ".file-row,.file-table-heading,.compact-empty,.file-loading,.file-inline-transfer",
): () => boolean {
  const before = currentLayout(list, rows);
  return () => {
    const after = currentLayout(list, rows);
    return (
      !!before &&
      !!after &&
      before.viewport.every(
        (value, index) => value === after.viewport[index],
      ) &&
      before.overlays.length === after.overlays.length &&
      before.overlays.every(
        (element, index) => element === after.overlays[index],
      ) &&
      before.regions.length === after.regions.length &&
      before.regions.every((region, index) => {
        const next = after.regions[index];
        return (
          region.element === next.element &&
          region.path === next.path &&
          region.geometry.every((value, axis) => value === next.geometry[axis])
        );
      })
    );
  };
}
