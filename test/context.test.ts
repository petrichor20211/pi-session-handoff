import { describe, expect, it } from "vitest";
import { parseTarget, renderBudgetMessage, snapshotBudget } from "../src/context.ts";

describe("handoff target", () => {
	it("parses percentages and token shorthand", () => {
		expect(parseTarget("35%")).toEqual({ kind: "percent", value: 35 });
		expect(parseTarget("80k")).toEqual({ kind: "tokens", value: 80_000 });
		expect(parseTarget("1.5m")).toEqual({ kind: "tokens", value: 1_500_000 });
	});

	it("rejects unreasonable or ambiguous targets", () => {
		expect(() => parseTarget("0%")).toThrow();
		expect(() => parseTarget("101%")).toThrow();
		expect(() => parseTarget("999")).toThrow();
		expect(() => parseTarget("lots")).toThrow();
	});
});

describe("context budget", () => {
	it("uses current context usage rather than cumulative totals", () => {
		const snapshot = snapshotBudget(
			{ tokens: 72_400, contextWindow: 200_000, percent: 36.2 },
			undefined,
			{ kind: "percent", value: 40 },
		);
		expect(snapshot.targetTokens).toBe(80_000);
		expect(snapshot.remainingToTarget).toBe(7_600);
		expect(renderBudgetMessage(snapshot, false)).toContain("used_tokens: approximately 72,400");
	});

	it("preserves unknown values instead of converting them to zero", () => {
		for (const tokens of [null, 0]) {
			const snapshot = snapshotBudget(
				{ tokens, contextWindow: 200_000, percent: null },
				undefined,
				{ kind: "tokens", value: 80_000 },
			);
			expect(renderBudgetMessage(snapshot, false)).toContain("used_tokens: unknown");
			expect(renderBudgetMessage(snapshot, false)).toContain("remaining_to_target: unknown");
		}
	});

	it("warns a continuation session against target-only handoff loops", () => {
		const snapshot = snapshotBudget(
			{ tokens: 90_000, contextWindow: 200_000, percent: 45 },
			undefined,
			{ kind: "tokens", value: 80_000 },
		);
		expect(renderBudgetMessage(snapshot, true)).toContain("do not create another handoff solely");
	});
});
