export type SerialJobQueue<T> = {
  enqueue(job: T): void;
  readonly depth: number;
  readonly running: boolean;
};

export function createSerialJobQueue<T>(params: {
  run: (job: T) => Promise<void>;
  onIdle?: () => void;
}): SerialJobQueue<T> {
  const queue: T[] = [];
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    const work = async () => {
      while (queue.length > 0) {
        const job = queue.shift()!;
        await params.run(job);
      }
    };
    await work().finally(() => {
      running = false;
    });
    params.onIdle?.();
  };

  return {
    enqueue(job) {
      queue.push(job);
      void drain();
    },
    get depth() {
      return queue.length;
    },
    get running() {
      return running;
    },
  };
}
