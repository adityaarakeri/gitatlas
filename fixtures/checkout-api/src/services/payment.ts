import { Order } from "../types";
export class PaymentService {
  async charge(order: Order): Promise<boolean> { return order.total > 0; }
  async refund(orderId: string): Promise<void> {}
}
export function neverCalled() {}
