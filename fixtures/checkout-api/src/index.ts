import { handleCheckout, healthCheck } from "./routes/checkout";
export function startServer(port: number) { return { port, handleCheckout, healthCheck }; }
