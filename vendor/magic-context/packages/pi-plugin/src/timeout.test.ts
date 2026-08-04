import { describe, expect, it, mock, spyOn } from "bun:test";

import { withTimeout } from "./timeout";

describe("withTimeout", () => {
	it("clears and unrefs the timer when work resolves before the timeout", async () => {
		const clearSpy = spyOn(globalThis, "clearTimeout");
		const result = await withTimeout(Promise.resolve("done"), 5_000);
		expect(result).toBe("done");
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});

	it("calls unref on timeout handles when available", async () => {
		const realSetTimeout = globalThis.setTimeout;
		const realClearTimeout = globalThis.clearTimeout;
		const unref = mock(() => undefined);
		const fakeHandle = { unref } as unknown as ReturnType<typeof setTimeout>;
		const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
		) => {
			realSetTimeout(callback, 0);
			return fakeHandle;
		}) as typeof setTimeout);
		const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((
			handle?: ReturnType<typeof setTimeout>,
		) => {
			if (handle !== fakeHandle) realClearTimeout(handle);
		}) as typeof clearTimeout);

		try {
			expect(
				await withTimeout(new Promise(() => undefined), 5_000),
			).toBeUndefined();
			expect(setSpy).toHaveBeenCalled();
			expect(unref).toHaveBeenCalledTimes(1);
			expect(clearSpy).toHaveBeenCalledWith(fakeHandle);
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});
});
