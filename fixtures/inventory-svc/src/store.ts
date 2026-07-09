export class StockStore {
  private levels = new Map<string, number>();
  get(sku: string) { return this.levels.get(sku) ?? 0; }
  decrement(sku: string, qty: number) { this.levels.set(sku, this.get(sku) - qty); }
}
