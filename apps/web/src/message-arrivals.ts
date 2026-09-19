export class MessageArrivals {
  private readonly seen = new Set<string>();
  private active = false;

  activate(existingIds: Iterable<string>) {
    for (const id of existingIds) this.seen.add(id);
    this.active = true;
  }

  deactivate() {
    this.active = false;
  }

  claim(id: string, live: boolean) {
    const first = !this.seen.has(id);
    this.seen.add(id);
    return first && live && this.active;
  }
}
