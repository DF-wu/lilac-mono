const widthProperties = {
  sidebar: ["--sidebar-panel-width", "--sidebar-offset"],
  right: ["--right-panel-width", "--right-panel-offset"],
} as const;

export function updatePanelWidth(
  element: HTMLElement | null,
  panel: keyof typeof widthProperties,
  pixels: number,
) {
  if (!element || pixels <= 0) return;
  const [width, offset] = widthProperties[panel];
  const value = `${pixels}px`;
  if (element.style.getPropertyValue(width) === value) return;
  // Collapse distances follow the measured width without rerendering the workspace during a drag.
  element.style.setProperty(width, value);
  element.style.setProperty(offset, `${pixels + 1}px`);
}
