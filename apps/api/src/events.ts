import { EventEmitter } from "node:events";
export const createEventBus = () => {
  const e = new EventEmitter();
  e.setMaxListeners(100);
  return e;
};
export interface OrderPaidEvent {
  orderId: string;
  number: string;
}
