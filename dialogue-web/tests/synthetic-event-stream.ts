/**
 * A synthetic `EventSource` for the composed shell's Chat event stream.
 *
 * `route.fulfill` cannot stream, so the transport is replaced inside the page. What that leaves
 * under test is the shell's own decisions - which URL and cursor it subscribes with, and what it
 * does with each frame - rather than how Chromium reassembles bytes, which is the Host's suite's
 * subject.
 *
 * A module rather than a copy per journey: the shell can be driven into most of its states only
 * through this stream, so a copy per spec is the same synthetic transport spelled as many times as
 * there are states to reach.
 */
import type { Page } from "./frontend-coverage";

type StreamState = {
  __streams: Array<{ url: string; closed: boolean }>;
  __sources: Array<{ onerror: ((event: unknown) => void) | null }>;
  __streamHandlers: Array<Map<string, Array<(raw: unknown) => void>>>;
  __emit: (index: number, type: string, data: string, id: string) => void;
};

export async function installSyntheticEventStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as unknown as StreamState;
    state.__streams = [];
    state.__sources = [];
    state.__streamHandlers = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor(url: string | URL) {
        this.__index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__sources.push(this);
        state.__streamHandlers.push(new Map());
      }
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {
        state.__streams[this.__index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__emit = (index, type, data, id) => {
      for (const handler of state.__streamHandlers[index]?.get(type) ?? []) handler({ data, lastEventId: id, type });
    };
  });
}

export async function streamUrls(page: Page): Promise<string[]> {
  return await page.evaluate(() => (window as unknown as StreamState).__streams.map((stream) => stream.url));
}

export async function streamClosed(page: Page, index: number): Promise<boolean> {
  return await page.evaluate((at: number) => (window as unknown as StreamState).__streams[at]!.closed, index);
}

/** The connection the shell opened at `index` drops, the way a lost link does. */
export async function failStream(page: Page, index: number): Promise<void> {
  await page.evaluate((at: number) => {
    const source = (window as unknown as StreamState).__sources[at];
    source?.onerror?.(new Event("error"));
  }, index);
}

/**
 * Deliver one frame to the connection the shell opened at `index`.
 *
 * The listener is registered per event type (`EVENT_TYPES` in `reference-pipeline-api.ts`), so the
 * frame's own `eventType` is the channel it arrives on - a frame dispatched as `"message"` reaches
 * no handler and would look like a frame the shell ignored.
 */
export async function emitStreamEvent(page: Page, index: number, event: unknown, id: string): Promise<void> {
  await page.evaluate(
    (input: { index: number; type: string; data: string; id: string }) => {
      (window as unknown as StreamState).__emit(input.index, input.type, input.data, input.id);
    },
    { index, type: (event as { eventType: string }).eventType, data: JSON.stringify(event), id },
  );
}

/** What the shell marked on the browser's own timeline, filtered to one `gamebuddy:turn:*` stage. */
export async function turnMarks(page: Page, stage: string): Promise<Array<string | null>> {
  return await page.evaluate((name: string) => {
    return performance
      .getEntriesByType("mark")
      .filter((entry) => entry.name === name)
      .map((entry) => (entry as PerformanceMark).detail?.turnKey ?? null);
  }, `gamebuddy:turn:${stage}`);
}
