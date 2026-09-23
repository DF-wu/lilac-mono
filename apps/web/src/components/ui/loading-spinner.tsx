import { Morph, type SpinnerProps } from "loading-dev";
import type { ComponentType } from "react";

export function LoadingSpinner({
  spinner: Spinner = Morph,
  size = 16,
}: {
  spinner?: ComponentType<SpinnerProps>;
  size?: number;
}) {
  return (
    <span
      data-slot="loading-spinner"
      aria-hidden="true"
      className={`inline-flex shrink-0 ${Spinner === Morph ? "[--ld-duration:calc(var(--ui-motion-spin-duration)*1.25)]" : "[--ld-duration:var(--ui-motion-spin-duration)]"}`}
    >
      <Spinner size={size} />
    </span>
  );
}
