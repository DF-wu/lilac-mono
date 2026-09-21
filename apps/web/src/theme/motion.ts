export function readMotionDuration(): number {
  const root = document.documentElement;
  if (root.dataset.animation === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches)
    return 0;
  const value = getComputedStyle(root).getPropertyValue("--ui-motion-duration").trim();
  const duration = parseFloat(value);
  if (!Number.isFinite(duration)) return 150;
  return value.endsWith("ms") ? duration : duration * 1000;
}
