export function hasFileDrag(data: Pick<DataTransfer, "types"> | null): boolean {
  return data?.types.includes("Files") ?? false;
}

export function installWindowFileDrop(
  target: Window,
  callbacks: {
    canAttach: () => boolean;
    show: (visible: boolean) => void;
    attach: (files: File[]) => void;
  },
): () => void {
  let depth = 0;
  function reset() {
    depth = 0;
    callbacks.show(false);
  }
  function enter(event: DragEvent) {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    depth++;
    callbacks.show(callbacks.canAttach());
  }
  function over(event: DragEvent) {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    const allowed = callbacks.canAttach();
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? "copy" : "none";
    callbacks.show(allowed);
  }
  function leave(event: DragEvent) {
    if (!hasFileDrag(event.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) callbacks.show(false);
  }
  function drop(event: DragEvent) {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    reset();
    if (!callbacks.canAttach() || !event.dataTransfer?.files.length) return;
    callbacks.attach([...event.dataTransfer.files]);
  }
  function key(event: KeyboardEvent) {
    if (event.key === "Escape") reset();
  }
  target.addEventListener("dragenter", enter, true);
  target.addEventListener("dragover", over, true);
  target.addEventListener("dragleave", leave, true);
  target.addEventListener("drop", drop, true);
  target.addEventListener("dragend", reset);
  target.addEventListener("blur", reset);
  target.addEventListener("keydown", key);
  return () => {
    target.removeEventListener("dragenter", enter, true);
    target.removeEventListener("dragover", over, true);
    target.removeEventListener("dragleave", leave, true);
    target.removeEventListener("drop", drop, true);
    target.removeEventListener("dragend", reset);
    target.removeEventListener("blur", reset);
    target.removeEventListener("keydown", key);
  };
}
