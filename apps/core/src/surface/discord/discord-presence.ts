const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export class DiscordPresence {
  private readonly activeRequests = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;
  private currentStatus: "online" | "idle" = "online";

  get status(): "online" | "idle" {
    return this.currentStatus;
  }

  constructor(private readonly onChange: () => void) {}

  start(): void {
    this.connected = true;
    this.setOnline();
    if (this.activeRequests.size === 0) this.scheduleIdle();
  }

  stop(): void {
    this.connected = false;
    this.clearTimer();
    this.activeRequests.clear();
  }

  requestStarted(requestId: string): void {
    this.activeRequests.add(requestId);
    this.clearTimer();
    this.setOnline();
  }

  requestSettled(requestId: string): void {
    if (!this.activeRequests.delete(requestId)) return;
    if (this.activeRequests.size === 0 && this.connected) this.scheduleIdle();
  }

  private setOnline(): void {
    if (this.currentStatus === "online") return;
    this.currentStatus = "online";
    if (this.connected) this.onChange();
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleIdle(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.currentStatus = "idle";
      this.onChange();
    }, IDLE_TIMEOUT_MS);
    this.timer.unref();
  }
}
