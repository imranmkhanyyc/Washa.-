import { describe, it, expect } from "vitest";
import {
  ORDER_STATUSES,
  canTransition,
  assertTransition,
  buildStatusEvent,
  InvalidTransitionError,
  releasesReservation,
} from "../src/orderMachine";

describe("order state machine", () => {
  it("allows the happy path DRAFT → CONFIRMED", () => {
    const path = [
      "DRAFT", "AWAITING_PAYMENT", "PAID", "PACKING", "READY",
      "RIDER_ASSIGNED", "PICKED_UP", "DELIVERED", "CONFIRMED",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("allows the call-back branch", () => {
    expect(canTransition("DELIVERED", "CALLBACK_REQUESTED")).toBe(true);
    expect(canTransition("CALLBACK_REQUESTED", "RESOLVED")).toBe(true);
  });

  it("allows side exits and payment retry", () => {
    expect(canTransition("AWAITING_PAYMENT", "PAYMENT_FAILED")).toBe(true);
    expect(canTransition("PAYMENT_FAILED", "AWAITING_PAYMENT")).toBe(true);
    expect(canTransition("AWAITING_PAYMENT", "EXPIRED")).toBe(true);
    expect(canTransition("PAYMENT_FAILED", "EXPIRED")).toBe(true);
    expect(canTransition("DRAFT", "CANCELLED")).toBe(true);
    expect(canTransition("AWAITING_PAYMENT", "CANCELLED")).toBe(true);
  });

  it("PAID is only reachable from AWAITING_PAYMENT", () => {
    for (const s of ORDER_STATUSES) {
      if (s === "AWAITING_PAYMENT") continue;
      expect(canTransition(s, "PAID")).toBe(false);
    }
  });

  it("throws on any transition not in the table", () => {
    expect(() => assertTransition("DRAFT", "PAID")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("PAID", "AWAITING_PAYMENT")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("CONFIRMED", "DELIVERED")).toThrow();
    expect(() => assertTransition("EXPIRED", "PAID")).toThrow();
    expect(() => assertTransition("PAID", "PAID")).toThrow();
  });

  it("terminal states have no exits", () => {
    for (const s of ["CONFIRMED", "RESOLVED", "EXPIRED", "CANCELLED"] as const) {
      for (const t of ORDER_STATUSES) expect(canTransition(s, t)).toBe(false);
    }
  });

  it("builds a status_events row with actor and timestamp", () => {
    const at = new Date("2026-01-01T10:00:00Z");
    const ev = buildStatusEvent("ord1", "AWAITING_PAYMENT", "PAID", { type: "system" }, at);
    expect(ev).toEqual({
      orderId: "ord1", fromStatus: "AWAITING_PAYMENT", toStatus: "PAID",
      actorType: "system", actorId: null, at,
    });
    expect(() => buildStatusEvent("o", "DRAFT", "PAID", { type: "system" })).toThrow();
  });

  it("knows which transitions release stock", () => {
    expect(releasesReservation("EXPIRED", { attempts: 1, maxAttempts: 3 })).toBe(true);
    expect(releasesReservation("CANCELLED", { attempts: 1, maxAttempts: 3 })).toBe(true);
    expect(releasesReservation("PAYMENT_FAILED", { attempts: 1, maxAttempts: 3 })).toBe(false);
    expect(releasesReservation("PAYMENT_FAILED", { attempts: 3, maxAttempts: 3 })).toBe(true);
    expect(releasesReservation("PAID", { attempts: 1, maxAttempts: 3 })).toBe(false);
  });
});
