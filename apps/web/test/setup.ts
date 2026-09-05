import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Shared setup for every frontend test (ADR-068).
 *
 * Two things are stubbed globally because jsdom does not implement them and every screen in
 * this app depends on them: `EventSource` (the agent task stream) and `matchMedia`. They are
 * stubbed rather than mocked away — the EventSource double below is a real, controllable
 * implementation, so a hook that listens for events can be driven deterministically.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A controllable EventSource: tests push events at it and assert what the hook did. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, handler: (event: MessageEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler));
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: deliver a server-sent event of `type` carrying `data`. */
  emit(type: string, data: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

vi.stubGlobal("EventSource", FakeEventSource);

if (!window.matchMedia) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}
