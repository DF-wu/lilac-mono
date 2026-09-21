import { readMotionDuration } from "../theme/motion";

type Position = { node: HTMLElement; top: number; width: number; height: number };
type Movement = { animation: Animation; offset: number };

function remaining({ animation, offset }: Movement) {
  return offset * (1 - Number(animation.effect?.getComputedTiming().progress ?? 1));
}

export function createVirtualListMotion(parent: HTMLElement) {
  let positions = new Map<string, Position>();
  let keys = new Set<string>();
  let order: string[] = [];
  let signature: string | undefined;
  const moving = new Map<HTMLElement, Movement>();
  const entering = new Map<HTMLElement, Animation>();
  const exiting = new Map<HTMLElement, Animation>();

  function clear() {
    for (const { animation } of moving.values()) animation.cancel();
    for (const animation of entering.values()) animation.cancel();
    for (const [node, animation] of exiting) {
      animation.cancel();
      node.remove();
    }
    moving.clear();
    entering.clear();
    exiting.clear();
  }

  function track(node: HTMLElement, animation: Animation, collection: Map<HTMLElement, Animation>) {
    collection.get(node)?.cancel();
    collection.set(node, animation);
    animation.onfinish = () => {
      if (collection.get(node) !== animation) return;
      collection.delete(node);
      if (collection === exiting) node.remove();
    };
  }

  return {
    update(allKeys: string[], enabled: boolean) {
      if (!enabled) {
        clear();
        positions.clear();
        keys.clear();
        order = [];
        signature = undefined;
        return;
      }
      const nodes = Array.from(parent.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement && !exiting.has(node),
      );
      const nextSignature = JSON.stringify([
        enabled,
        allKeys,
        nodes.map((node) => [node.dataset.motionKey, node.style.transform]),
      ]);
      if (signature === nextSignature) return;
      const orderChanged =
        allKeys.length !== order.length || allKeys.some((key, index) => key !== order[index]);
      const nextKeys = new Set(allKeys);
      const next = new Map<string, Position>();
      // Batch layout reads before creating ghosts or starting animations.
      for (const node of nodes)
        next.set(node.dataset.motionKey!, {
          node,
          top: Number(node.dataset.motionTop),
          width: node.offsetWidth,
          height: node.offsetHeight,
        });
      const duration = readMotionDuration();
      const removed = [...positions].filter(
        ([key]) => !nextKeys.has(key) || (orderChanged && !next.has(key)),
      );
      const added = [...next].filter(
        ([key]) => !keys.has(key) || (orderChanged && !positions.has(key)),
      );
      const animate =
        (orderChanged || moving.size > 0 || entering.size > 0 || exiting.size > 0) &&
        signature !== undefined &&
        duration > 0 &&
        removed.length + added.length <= 40;
      signature = nextSignature;
      const timing = { duration, easing: "ease-out" };
      if (!animate) clear();
      if (animate) {
        for (const [, position] of removed) {
          const { node, top, width, height } = position;
          // React owns the real row. Its fading copy cannot receive input or expose duplicate IDs.
          const clone = node.cloneNode(true);
          if (!(clone instanceof HTMLElement)) continue;
          for (const element of [clone, ...clone.querySelectorAll("[id], [data-motion-key]")]) {
            element.removeAttribute("id");
            element.removeAttribute("data-motion-key");
          }
          clone.dataset.motionExit = "";
          clone.inert = true;
          clone.setAttribute("aria-hidden", "true");
          const movement = moving.get(node);
          Object.assign(clone.style, {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translateY(${top + (movement ? remaining(movement) : 0)}px)`,
            pointerEvents: "none",
            transition: "none",
          });
          parent.append(clone);
          const opacity = Number(entering.get(node)?.effect?.getComputedTiming().progress ?? 1);
          track(
            clone,
            clone.animate(
              [{ opacity }, { opacity: opacity * 0.4, offset: 0.3 }, { opacity: 0 }],
              timing,
            ),
            exiting,
          );
        }
        for (const [key, position] of next) {
          const previous = positions.get(key);
          const { node, top } = position;
          if (!previous) {
            // Virtualized rows entering the viewport are not newly added threads.
            if (orderChanged || !keys.has(key))
              track(node, node.animate([{ opacity: 0 }, { opacity: 1 }], timing), entering);
            continue;
          }
          if (previous.top === top || previous.node !== node) continue;
          const current = moving.get(node);
          const offset = previous.top + (current ? remaining(current) : 0) - top;
          current?.animation.cancel();
          const animation = node.animate(
            [{ transform: `translateY(${top + offset}px)` }, { transform: `translateY(${top}px)` }],
            { ...timing, delay: removed.length ? duration * 0.15 : 0, fill: "backwards" },
          );
          moving.set(node, { animation, offset });
          animation.onfinish = () => {
            if (moving.get(node)?.animation === animation) moving.delete(node);
          };
        }
      }
      const mounted = new Set(nodes);
      for (const [node, movement] of moving) {
        if (mounted.has(node)) continue;
        movement.animation.cancel();
        moving.delete(node);
      }
      for (const [node, animation] of entering) {
        if (mounted.has(node)) continue;
        animation.cancel();
        entering.delete(node);
      }
      positions = next;
      keys = nextKeys;
      order = allKeys;
    },
    dispose: clear,
  };
}
