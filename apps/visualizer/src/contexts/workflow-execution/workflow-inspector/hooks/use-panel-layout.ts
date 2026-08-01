import { createSignal } from "solid-js";
import type { PanelKind } from "../models/workflow-inspector-models";

const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 420;

const clampPanelWidth = (value: number) =>
  Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, value));

export function usePanelLayout() {
  const [navigatorWidth, setNavigatorWidth] = createSignal(260);
  const [inspectorWidth, setInspectorWidth] = createSignal(300);
  const [navigatorCollapsed, setNavigatorCollapsed] = createSignal(false);
  const [inspectorCollapsed, setInspectorCollapsed] = createSignal(false);

  const startResize = (panel: PanelKind, event: PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const initial = panel === "navigator" ? navigatorWidth() : inspectorWidth();
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const next = panel === "navigator" ? initial + delta : initial - delta;
      const bounded = clampPanelWidth(next);
      if (panel === "navigator") setNavigatorWidth(bounded);
      else setInspectorWidth(bounded);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const keyboardResize = (panel: PanelKind, event: KeyboardEvent) => {
    const amount =
      event.key === "ArrowLeft"
        ? -16
        : event.key === "ArrowRight"
          ? 16
          : event.key === "Home"
            ? -10_000
            : event.key === "End"
              ? 10_000
              : 0;
    if (amount === 0) return;
    event.preventDefault();
    const current = panel === "navigator" ? navigatorWidth() : inspectorWidth();
    const next =
      amount < -1_000 ? MIN_PANEL_WIDTH : amount > 1_000 ? MAX_PANEL_WIDTH : current + amount;
    if (panel === "navigator") setNavigatorWidth(clampPanelWidth(next));
    else setInspectorWidth(clampPanelWidth(next));
  };

  return {
    navigatorWidth,
    inspectorWidth,
    navigatorCollapsed,
    inspectorCollapsed,
    setNavigatorCollapsed,
    setInspectorCollapsed,
    startResize,
    keyboardResize,
  };
}
