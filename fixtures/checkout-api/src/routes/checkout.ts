import { PaymentService } from "../services/payment";
import { InventoryClient } from "../services/inventory-client";
export async function handleCheckout(req: unknown) {
  const payments = new PaymentService();
  const inventory = new InventoryClient(process.env.INVENTORY_URL ?? "");
  return { ok: true };
}
export function healthCheck() { return "ok"; }
export const validateCart = (items: unknown[]) => items.length > 0;
