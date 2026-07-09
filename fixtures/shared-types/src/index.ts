export interface Order { id: string; items: LineItem[]; total: number; }
export interface LineItem { sku: string; qty: number; price: number; }
export type ReservationStatus = "reserved" | "rejected" | "expired";
export interface Reservation { orderId: string; status: ReservationStatus; }
