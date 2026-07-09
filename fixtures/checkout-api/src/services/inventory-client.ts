import { Order } from "../types";
export class InventoryClient {
  constructor(private baseUrl: string) {}
  async reserve(order: Order) {
    return fetch(`${this.baseUrl}/reserve`, { method: "POST", body: JSON.stringify(order) });
  }
}
