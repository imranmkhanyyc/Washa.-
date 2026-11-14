/**
 * Order state machine (docs/01-architecture.md).
 * Any transition not in TRANSITIONS throws.
 */
export const ORDER_STATUSES = [
  "DRAFT",
  "AWAITING_PAYMENT",
  "PAID",
  "PACKING",
  "READY",
  "RIDER_ASSIGNED",
  "PICKED_UP",
  "DELIVERED",
  "CONFIRMED",
  "CALLBACK_REQUESTED",
  "RESOLVED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type ActorType = "system" | "customer" | "staff" | "rider";
export interface Actor {
  type: ActorType;
  id?: string | null;
}

export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ["AWAITING_PAYMENT", "CANCELLED"],
  AWAITING_PAYMENT: ["PAID", "PAYMENT_FAILED", "EXPIRED", "CANCELLED"],
  // Retryable: a new STK push moves it back to AWAITING_PAYMENT.
  PAYMENT_FAILED: ["AWAITING_PAYMENT", "EXPIRED", "CANCELLED"],
  PAID: ["PACKING"],
  PACKING: ["READY"],
  READY: ["RIDER_ASSIGNED"],
  RIDER_ASSIGNED: ["PICKED_UP"],
  PICKED_UP: ["DELIVERED"],
  DELIVERED: ["CONFIRMED", "CALLBACK_REQUESTED"],
  CALLBACK_REQUESTED: ["RESOLVED"],
  CONFIRMED: [],
  RESOLVED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
  ) {
    super(`Invalid order transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export interface StatusEventRow {
  orderId: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  actorType: ActorType;
  actorId: string | null;
  at: Date;
}

/** Validates the transition and returns the status_events row to write. */
export function buildStatusEvent(
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  actor: Actor,
  at: Date = new Date(),
): StatusEventRow {
  assertTransition(from, to);
  return { orderId, fromStatus: from, toStatus: to, actorType: actor.type, actorId: actor.id ?? null, at };
}

/**
 * Stock reservation: reserve at AWAITING_PAYMENT, release on EXPIRED / CANCELLED /
 * PAYMENT_FAILED (only after the final retry), decrement on PAID.
 */
export function releasesReservation(
  to: OrderStatus,
  ctx: { attempts: number; maxAttempts: number },
): boolean {
  if (to === "EXPIRED" || to === "CANCELLED") return true;
  if (to === "PAYMENT_FAILED") return ctx.attempts >= ctx.maxAttempts;
  return false;
}
