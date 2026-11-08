export type TravelClass = "1A" | "2A" | "3A" | "3E" | "SL" | "CC" | "EC";
export type BookingQuota = "GENERAL" | "TATKAL" | "PREMIUM_TATKAL";
export type PassengerGender = "M" | "F" | "T";
export type BerthPreference = "LB" | "MB" | "UB" | "SL" | "SU" | "WINDOW" | "NONE";

export interface PassengerDetails {
  name: string;
  age: number;
  gender: PassengerGender;
  berthPreference?: BerthPreference;
  foodPreference?: "V" | "NV" | "N";
}

export interface JourneyDetails {
  originStation: string;
  destinationStation: string;
  journeyDate: string; // YYYY-MM-DD
  trainNumber: string;
  travelClass: TravelClass;
  quota: BookingQuota;
  passengers: PassengerDetails[];
}

export interface TatkalWindowStatus {
  isOpen: boolean;
  opensAt: Date;
  closesAt: Date;
  status: "NOT_YET_OPEN" | "OPEN" | "CLOSED";
  message: string;
}

export interface FareBreakdown {
  baseFare: number;
  tatkalCharge: number;
  convenienceFee: number;
  gst: number;
  totalAmount: number;
  currency: "INR";
}

export interface AvailabilityResult {
  available: boolean;
  statusText: string; // e.g. "AVAILABLE-0042", "WL-0012", "REGRET"
  availableSeats: number;
  fare: FareBreakdown;
}

export interface PaymentGateApprovalRequest {
  requiresUserConfirmation: true;
  bookingSessionId: string;
  trainNumber: string;
  journeyDate: string;
  travelClass: TravelClass;
  passengerCount: number;
  fare: FareBreakdown;
  summary: string;
}

export interface BookingConfirmation {
  pnr: string;
  trainNumber: string;
  journeyDate: string;
  origin: string;
  destination: string;
  bookingStatus: "CONFIRMED" | "WAITLISTED" | "RAC";
  passengers: Array<{
    name: string;
    bookingStatus: string;
    coach?: string;
    berthNumber?: number;
    berthType?: string;
  }>;
  totalPaid: number;
  transactionId: string;
  bookedAt: string;
  isSimulated: boolean;
}

export interface IrctcClientAdapter {
  name: string;
  checkAvailability(journey: JourneyDetails): Promise<AvailabilityResult>;
  submitPassengerDetails(sessionId: string, passengers: PassengerDetails[]): Promise<{ ok: boolean; message?: string }>;
  requestCaptchaChallenge(sessionId: string): Promise<{ challengeId: string; imageUrl?: string }>;
  verifyCaptcha(sessionId: string, challengeId: string, solution: string): Promise<boolean>;
  executeBookingPayment(sessionId: string, authorizationToken: string, expectedAmount: number): Promise<BookingConfirmation>;
}

/**
 * Validates IRCTC Tatkal booking window according to official Indian Railways rules.
 * AC Classes (1A, 2A, 3A, 3E, CC, EC): Opens at 10:00 AM IST on the day prior to journey.
 * Non-AC Classes (SL): Opens at 11:00 AM IST on the day prior to journey.
 */
export function evaluateTatkalWindow(
  journeyDateStr: string,
  travelClass: TravelClass,
  currentTime: Date = new Date()
): TatkalWindowStatus {
  // Parse journey date (assumed in IST / UTC+05:30)
  const [year, month, day] = journeyDateStr.split("-").map(Number);
  
  // Tatkal opens on the day prior to journey date
  const openingDay = new Date(Date.UTC(year, month - 1, day - 1));
  
  // IST is UTC+5:30 -> 10:00 AM IST is 04:30 AM UTC; 11:00 AM IST is 05:30 AM UTC
  const isAc = ["1A", "2A", "3A", "3E", "CC", "EC"].includes(travelClass);
  const openHourUtc = isAc ? 4 : 5;
  const openMinuteUtc = 30;

  const opensAt = new Date(Date.UTC(
    openingDay.getUTCFullYear(),
    openingDay.getUTCMonth(),
    openingDay.getUTCDate(),
    openHourUtc,
    openMinuteUtc,
    0
  ));

  // Closes at chart preparation / departure time (nominally 24 hours after opening)
  const closesAt = new Date(opensAt.getTime() + 24 * 60 * 60 * 1000);

  const nowMs = currentTime.getTime();
  const openMs = opensAt.getTime();
  const closeMs = closesAt.getTime();

  if (nowMs < openMs) {
    const diffMinutes = Math.round((openMs - nowMs) / 60000);
    return {
      isOpen: false,
      opensAt,
      closesAt,
      status: "NOT_YET_OPEN",
      message: `Tatkal booking for ${travelClass} opens at ${opensAt.toISOString()} (in ~${diffMinutes} minutes).`,
    };
  }

  if (nowMs > closeMs) {
    return {
      isOpen: false,
      opensAt,
      closesAt,
      status: "CLOSED",
      message: `Tatkal booking window closed for journey date ${journeyDateStr}.`,
    };
  }

  return {
    isOpen: true,
    opensAt,
    closesAt,
    status: "OPEN",
    message: `Tatkal booking window is currently active for ${travelClass}.`,
  };
}

/**
 * Validates travel inputs against IRCTC Tatkal constraints.
 */
export function validateTatkalJourneyRequest(request: JourneyDetails): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!/^[A-Z]{2,5}$/.test(request.originStation)) {
    errors.push(`Invalid origin station code: "${request.originStation}"`);
  }
  if (!/^[A-Z]{2,5}$/.test(request.destinationStation)) {
    errors.push(`Invalid destination station code: "${request.destinationStation}"`);
  }
  if (request.originStation === request.destinationStation) {
    errors.push("Origin and destination stations cannot be identical");
  }
  if (!/^\d{4,5}$/.test(request.trainNumber)) {
    errors.push(`Invalid train number: "${request.trainNumber}" (expected 4-5 digits)`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.journeyDate)) {
    errors.push(`Invalid journey date format: "${request.journeyDate}" (expected YYYY-MM-DD)`);
  }

  if (!request.passengers || request.passengers.length === 0) {
    errors.push("At least one passenger must be specified");
  } else if (request.quota === "TATKAL" && request.passengers.length > 4) {
    // Official IRCTC limit: Max 4 passengers per PNR under Tatkal quota
    errors.push(`Tatkal quota permits maximum 4 passengers per booking (got ${request.passengers.length})`);
  }

  for (let i = 0; i < (request.passengers || []).length; i++) {
    const p = request.passengers[i];
    if (!p.name || p.name.trim().length < 2) {
      errors.push(`Passenger #${i + 1}: Name is required (minimum 2 characters)`);
    }
    if (typeof p.age !== "number" || p.age < 1 || p.age > 125) {
      errors.push(`Passenger #${i + 1}: Invalid age (${p.age})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * High-fidelity Mock Client for IRCTC Booking Simulation.
 */
export class MockIrctcClient implements IrctcClientAdapter {
  name = "mock-irctc";

  constructor(
    private options: {
      forceAvailability?: boolean;
      availableCount?: number;
      simulatePaymentFailure?: boolean;
    } = {}
  ) {}

  async checkAvailability(journey: JourneyDetails): Promise<AvailabilityResult> {
    const available = this.options.forceAvailability ?? true;
    const availableSeats = available ? (this.options.availableCount ?? 18) : 0;
    const baseFare = journey.travelClass === "1A" ? 3200 : journey.travelClass === "2A" ? 2100 : journey.travelClass === "3A" ? 1450 : 450;
    const tatkalCharge = journey.travelClass === "1A" ? 500 : journey.travelClass === "2A" ? 400 : journey.travelClass === "3A" ? 300 : 125;
    const convenienceFee = 17.7;
    const passengerCount = journey.passengers.length;
    const totalAmount = (baseFare + tatkalCharge) * passengerCount + convenienceFee;

    return {
      available,
      statusText: available ? `AVAILABLE-${String(availableSeats).padStart(4, "0")}` : "WL-0024",
      availableSeats,
      fare: {
        baseFare: baseFare * passengerCount,
        tatkalCharge: tatkalCharge * passengerCount,
        convenienceFee,
        gst: Math.round(baseFare * 0.05 * passengerCount),
        totalAmount: Math.round(totalAmount),
        currency: "INR",
      },
    };
  }

  async submitPassengerDetails(_sessionId: string, _passengers: PassengerDetails[]): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async requestCaptchaChallenge(_sessionId: string): Promise<{ challengeId: string }> {
    return { challengeId: "captcha-mock-4242" };
  }

  async verifyCaptcha(_sessionId: string, _challengeId: string, solution: string): Promise<boolean> {
    return Boolean(solution && solution.length >= 4);
  }

  async executeBookingPayment(
    sessionId: string,
    authorizationToken: string,
    expectedAmount: number
  ): Promise<BookingConfirmation> {
    if (this.options.simulatePaymentFailure) {
      throw new Error("Payment transaction declined by payment gateway (SIMULATED_DECLINE)");
    }
    if (!authorizationToken) {
      throw new Error("Missing user payment authorization token");
    }

    const randomPnr = "284" + Math.floor(1000000 + Math.random() * 9000000);
    return {
      pnr: randomPnr,
      trainNumber: "12952",
      journeyDate: "2026-10-21",
      origin: "NDLS",
      destination: "BCT",
      bookingStatus: "CONFIRMED",
      passengers: [
        {
          name: "Passenger 1",
          bookingStatus: "CNF",
          coach: "B4",
          berthNumber: 23,
          berthType: "LB",
        },
      ],
      totalPaid: expectedAmount,
      transactionId: `TXN-${sessionId.slice(0, 8)}-${Date.now()}`,
      bookedAt: new Date().toISOString(),
      isSimulated: true,
    };
  }
}

/**
 * Universal Agent Travel Orchestrator.
 * Manages the multi-stage Tatkal booking journey with strict security checkpoints.
 */
export class TravelOrchestrator {
  constructor(private client: IrctcClientAdapter = new MockIrctcClient()) {}

  /**
   * Phase 1: Validate input, verify window, check availability, and prepare approval gate.
   */
  async prepareBooking(
    journey: JourneyDetails,
    currentTime: Date = new Date()
  ): Promise<{
    ok: boolean;
    error?: string;
    stage: "WINDOW_BLOCKED" | "VALIDATION_FAILED" | "SEATS_UNAVAILABLE" | "AWAITING_PAYMENT_APPROVAL";
    windowStatus?: TatkalWindowStatus;
    availability?: AvailabilityResult;
    paymentGate?: PaymentGateApprovalRequest;
  }> {
    // Step 1: Input Validation
    const validation = validateTatkalJourneyRequest(journey);
    if (!validation.valid) {
      return {
        ok: false,
        error: `Validation failed: ${validation.errors.join("; ")}`,
        stage: "VALIDATION_FAILED",
      };
    }

    // Step 2: Tatkal Window Verification
    if (journey.quota === "TATKAL" || journey.quota === "PREMIUM_TATKAL") {
      const windowStatus = evaluateTatkalWindow(journey.journeyDate, journey.travelClass, currentTime);
      if (!windowStatus.isOpen) {
        return {
          ok: false,
          error: windowStatus.message,
          stage: "WINDOW_BLOCKED",
          windowStatus,
        };
      }
    }

    // Step 3: Availability & Fare Check
    const availability = await this.client.checkAvailability(journey);
    if (!availability.available || availability.availableSeats < journey.passengers.length) {
      return {
        ok: false,
        error: `Seats unavailable on train ${journey.trainNumber} (${availability.statusText})`,
        stage: "SEATS_UNAVAILABLE",
        availability,
      };
    }

    // Step 4: Construct Payment Gate Checkpoint
    const sessionId = `irctc-sess-${Date.now()}`;
    const paymentGate: PaymentGateApprovalRequest = {
      requiresUserConfirmation: true,
      bookingSessionId: sessionId,
      trainNumber: journey.trainNumber,
      journeyDate: journey.journeyDate,
      travelClass: journey.travelClass,
      passengerCount: journey.passengers.length,
      fare: availability.fare,
      summary: `Booking ${journey.passengers.length} seat(s) on Train ${journey.trainNumber} (${journey.originStation} -> ${journey.destinationStation}) in ${journey.travelClass}. Total Payable: INR ${availability.fare.totalAmount}. Explicit user confirmation required to charge.`,
    };

    return {
      ok: true,
      stage: "AWAITING_PAYMENT_APPROVAL",
      availability,
      paymentGate,
    };
  }

  /**
   * Phase 2: Execute booking only upon valid user payment authorization.
   */
  async confirmAndBook(
    sessionId: string,
    authorizationToken: string,
    authorizedAmount: number
  ): Promise<BookingConfirmation> {
    if (!authorizationToken || authorizationToken.trim().length === 0) {
      throw new Error("Payment authorization rejected: Missing required user approval token");
    }

    return this.client.executeBookingPayment(sessionId, authorizationToken, authorizedAmount);
  }
}
