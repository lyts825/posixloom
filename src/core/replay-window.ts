/** Active IDs are never evicted. Completed IDs have a bounded, documented replay window. */
export class ReplayWindow {
  private readonly active = new Set<string>();
  private readonly completed = new Map<string, number>();
  constructor(private readonly maximum: number, private readonly ttlMs: number, private readonly now = Date.now) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid replay window limits");
  }
  private prune(): void {
    const now = this.now();
    for (const [id, expires] of this.completed) { if (expires > now) break; this.completed.delete(id); }
  }
  begin(id: string): boolean {
    this.prune();
    if (this.active.has(id) || this.completed.has(id)) return false;
    this.active.add(id);
    return true;
  }
  finish(id: string): void {
    if (!this.active.delete(id)) return;
    this.prune();
    this.completed.set(id, this.now() + this.ttlMs);
    while (this.completed.size > this.maximum) this.completed.delete(this.completed.keys().next().value!);
  }
  get size(): number { this.prune(); return this.active.size + this.completed.size; }
}
