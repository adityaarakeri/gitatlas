import { StockStore } from "./store";
export class ReservationEngine extends StockStore {
  reserve(sku: string, qty: number): boolean {
    if (this.get(sku) < qty) return false;
    this.decrement(sku, qty);
    return true;
  }
}
export function expireStale() {}
