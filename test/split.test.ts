import { describe, expect, it } from "vitest";
import { splitAmount, splitMinor } from "../src/split.js";

describe("fair split", () => {
  it("gives the remainder to the first person or persons", () => {
    expect(splitAmount(100, "EUR", 3)).toEqual([33.34, 33.33, 33.33]);
    expect(splitAmount(151, "EUR", 6)).toEqual([25.17, 25.17, 25.17, 25.17, 25.16, 25.16]);
    expect(splitAmount(10, "USD", 4)).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(splitAmount(0.05, "EUR", 3)).toEqual([0.02, 0.02, 0.01]);
  });

  it("splits whole yen for JPY", () => {
    expect(splitAmount(1000, "JPY", 3)).toEqual([334, 333, 333]);
  });

  it("handles float input like 0.1 + 0.2", () => {
    expect(splitAmount(0.1 + 0.2, "EUR", 2)).toEqual([0.15, 0.15]);
    expect(splitAmount(19.99, "EUR", 1)).toEqual([19.99]);
  });

  it("always adds up, never differs by more than one unit, never goes up (20 000 random cases)", () => {
    let seed = 21;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const bad: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const total = rand(10_000_000);
      const count = 1 + rand(21);
      const shares = splitMinor(total, count);
      const sum = shares.reduce((a, b) => a + b, 0);
      const sorted = shares.every((v, k) => k === 0 || v <= shares[k - 1]!);
      if (shares.length !== count || sum !== total || Math.max(...shares) - Math.min(...shares) > 1 || !sorted) bad.push(`${total}/${count}`);
    }
    expect(bad).toEqual([]);
  });

  it("refuses nonsense", () => {
    expect(() => splitMinor(100, 0)).toThrow();
    expect(() => splitMinor(1.5, 2)).toThrow();
    expect(() => splitMinor(-1, 2)).toThrow();
  });
});
