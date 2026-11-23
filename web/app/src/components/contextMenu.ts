import { useCallback, useState, type MouseEvent } from 'react';

export interface MenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuController {
  anchor: HTMLElement | null;
  point: MenuPoint | null;
  returnFocusTo: HTMLElement | null;
  isOpen: boolean;
  toggleFromAnchor: (element: HTMLElement) => void;
  openAtEvent: (event: MouseEvent<HTMLElement>) => void;
  close: () => void;
}

/** Clamps a pointer-opened menu inside viewport bounds, flipping left or up near window edges. */
export function computePointMenuPosition(
  point: MenuPoint,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  edge = 8,
): { left: number; top: number; maxHeight: number } {
  const maxHeight = Math.max(120, viewport.height - 2 * edge);
  const clampedHeight = Math.min(menu.height, maxHeight);
  const rightLimit = Math.max(edge, viewport.width - menu.width - edge);
  const bottomLimit = Math.max(edge, viewport.height - clampedHeight - edge);

  const fitsRight = point.x + menu.width <= viewport.width - edge;
  const rawLeft = fitsRight ? point.x : point.x - menu.width;
  const left = Math.min(Math.max(edge, rawLeft), rightLimit);

  const fitsBelow = point.y + clampedHeight <= viewport.height - edge;
  const rawTop = fitsBelow ? point.y : point.y - clampedHeight;
  const top = Math.min(Math.max(edge, rawTop), bottomLimit);

  return { left, top, maxHeight };
}

/** Coordinates button-anchored clicks and right-click cursor coordinates for a single Menu. */
export function useContextMenu(): ContextMenuController {
  const [state, setState] = useState<{
    anchor: HTMLElement | null;
    point: MenuPoint | null;
    returnFocusTo: HTMLElement | null;
  }>({ anchor: null, point: null, returnFocusTo: null });

  const close = useCallback(() => {
    setState({ anchor: null, point: null, returnFocusTo: null });
  }, []);

  const toggleFromAnchor = useCallback((element: HTMLElement) => {
    setState((prev) =>
      prev.anchor === element && prev.point === null
        ? { anchor: null, point: null, returnFocusTo: null }
        : { anchor: element, point: null, returnFocusTo: element },
    );
  }, []);

  const openAtEvent = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setState({
      anchor: null,
      point: { x: event.clientX, y: event.clientY },
      returnFocusTo: event.currentTarget,
    });
  }, []);

  return {
    anchor: state.anchor,
    point: state.point,
    returnFocusTo: state.returnFocusTo,
    isOpen: state.anchor !== null || state.point !== null,
    toggleFromAnchor,
    openAtEvent,
    close,
  };
}
