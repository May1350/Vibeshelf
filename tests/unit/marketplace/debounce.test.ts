import { describe, expect, it, vi } from "vitest";
import { debounce } from "@/lib/marketplace/debounce";

describe("debounce", () => {
  it("delays invocation by delayMs", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("collapses rapid invocations to one", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    for (let i = 0; i < 5; i++) d();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes latest arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d("a" as never);
    d("b" as never);
    d("c" as never);
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledWith("c");
    vi.useRealTimers();
  });

  it("cancel() prevents pending invocation", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    d.cancel();
    vi.advanceTimersByTime(150);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
