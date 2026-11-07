import { describe, expect, it } from "vitest";
import {
  evaluateTatkalWindow,
  validateTatkalJourneyRequest,
  TravelOrchestrator,
  MockIrctcClient,
  type JourneyDetails,
} from "./travel-orchestrator.js";

const VALID_JOURNEY: JourneyDetails = {
  originStation: "NDLS",
  destinationStation: "BCT",
  journeyDate: "2026-10-25",
  trainNumber: "12952",
  travelClass: "3A",
  quota: "TATKAL",
  passengers: [
    { name: "Aarav Sharma", age: 32, gender: "M", berthPreference: "LB" },
    { name: "Priya Sharma", age: 29, gender: "F", berthPreference: "MB" },
  ],
};

describe("TravelOrchestrator & Tatkal Booking Workflow", () => {
  describe("Input Validation", () => {
    it("accepts a valid Tatkal journey request", () => {
      const result = validateTatkalJourneyRequest(VALID_JOURNEY);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects invalid station codes and matching origin/destination", () => {
      const invalid = {
        ...VALID_JOURNEY,
        originStation: "DELHI_STATION_LONG",
        destinationStation: "DELHI_STATION_LONG",
      };
      const result = validateTatkalJourneyRequest(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("enforces IRCTC Tatkal passenger limit of maximum 4 passengers", () => {
      const fivePassengers: JourneyDetails = {
        ...VALID_JOURNEY,
        passengers: [
          { name: "P1", age: 20, gender: "M" },
          { name: "P2", age: 21, gender: "F" },
          { name: "P3", age: 22, gender: "M" },
          { name: "P4", age: 23, gender: "F" },
          { name: "P5", age: 24, gender: "M" },
        ],
      };
      const result = validateTatkalJourneyRequest(fivePassengers);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("maximum 4 passengers"))).toBe(true);
    });
  });

  describe("Tatkal Booking Window Rules", () => {
    it("reports NOT_YET_OPEN when checked before 10:00 AM IST on the previous day for AC", () => {
      // Journey on 2026-10-25. Previous day is 2026-10-24.
      // 10:00 AM IST is 04:30 UTC. Let's check at 03:00 UTC (08:30 AM IST).
      const checkTime = new Date("2026-10-24T03:00:00Z");
      const window = evaluateTatkalWindow("2026-10-25", "3A", checkTime);

      expect(window.isOpen).toBe(false);
      expect(window.status).toBe("NOT_YET_OPEN");
      expect(window.message).toContain("opens at");
    });

    it("reports OPEN when checked during active window (e.g. 10:05 AM IST for AC)", () => {
      // 10:05 AM IST is 04:35 UTC on 2026-10-24
      const checkTime = new Date("2026-10-24T04:35:00Z");
      const window = evaluateTatkalWindow("2026-10-25", "3A", checkTime);

      expect(window.isOpen).toBe(true);
      expect(window.status).toBe("OPEN");
      expect(window.message).toContain("active");
    });

    it("reports NOT_YET_OPEN for Sleeper (SL) at 10:30 AM IST (opens at 11:00 AM IST)", () => {
      // 10:30 AM IST is 05:00 UTC. Non-AC Tatkal opens at 11:00 AM IST (05:30 UTC).
      const checkTime = new Date("2026-10-24T05:00:00Z");
      const window = evaluateTatkalWindow("2026-10-25", "SL", checkTime);

      expect(window.isOpen).toBe(false);
      expect(window.status).toBe("NOT_YET_OPEN");
    });
  });

  describe("End-to-End Orchestration & Payment Checkpoint", () => {
    it("stops at AWAITING_PAYMENT_APPROVAL presenting exact total fare before charging", async () => {
      const orchestrator = new TravelOrchestrator(new MockIrctcClient());
      const activeWindowTime = new Date("2026-10-24T04:45:00Z");

      const prepResult = await orchestrator.prepareBooking(VALID_JOURNEY, activeWindowTime);

      expect(prepResult.ok).toBe(true);
      expect(prepResult.stage).toBe("AWAITING_PAYMENT_APPROVAL");
      expect(prepResult.paymentGate).toBeDefined();

      const gate = prepResult.paymentGate!;
      expect(gate.requiresUserConfirmation).toBe(true);
      expect(gate.fare.totalAmount).toBeGreaterThan(0);
      expect(gate.fare.currency).toBe("INR");
      expect(gate.summary).toContain("Explicit user confirmation required");

      // Phase 2: Confirmation with user approval token
      const booking = await orchestrator.confirmAndBook(
        gate.bookingSessionId,
        "USER_CONFIRMED_AUTH_TOKEN_789",
        gate.fare.totalAmount
      );

      expect(booking.pnr).toMatch(/^\d{10}$/);
      expect(booking.bookingStatus).toBe("CONFIRMED");
      expect(booking.totalPaid).toBe(gate.fare.totalAmount);
      expect(booking.isSimulated).toBe(true);
    });

    it("refuses payment execution when authorization token is missing", async () => {
      const orchestrator = new TravelOrchestrator(new MockIrctcClient());
      await expect(
        orchestrator.confirmAndBook("session-123", "", 2500)
      ).rejects.toThrow("Missing required user approval token");
    });

    it("handles seats unavailable cleanly without crashing", async () => {
      const orchestrator = new TravelOrchestrator(
        new MockIrctcClient({ forceAvailability: false })
      );
      const activeWindowTime = new Date("2026-10-24T04:45:00Z");

      const result = await orchestrator.prepareBooking(VALID_JOURNEY, activeWindowTime);
      expect(result.ok).toBe(false);
      expect(result.stage).toBe("SEATS_UNAVAILABLE");
      expect(result.error).toContain("unavailable");
    });
  });
});
