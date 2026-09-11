import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export type HandoffTarget =
	| { kind: "percent"; value: number }
	| { kind: "tokens"; value: number };

export interface BudgetSnapshot {
	usedTokens: number | null;
	contextWindow: number | null;
	targetTokens: number | null;
	remainingToTarget: number | null;
	target: HandoffTarget;
}

export const DEFAULT_TARGET: HandoffTarget = { kind: "percent", value: 35 };

export function parseTarget(input: string): HandoffTarget {
	const value = input.trim().toLowerCase().replaceAll(",", "");
	const percentMatch = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (percentMatch) {
		const percent = Number(percentMatch[1]);
		if (percent > 0 && percent <= 100) return { kind: "percent", value: percent };
		throw new Error("Percentage targets must be greater than 0% and no more than 100%.");
	}

	const tokenMatch = value.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
	if (!tokenMatch) throw new Error("Use a percentage such as 35% or a token count such as 80k.");

	const multiplier = tokenMatch[2] === "m" ? 1_000_000 : tokenMatch[2] === "k" ? 1_000 : 1;
	const tokens = Math.round(Number(tokenMatch[1]) * multiplier);
	if (!Number.isSafeInteger(tokens) || tokens < 1_000) {
		throw new Error("Token targets must be at least 1,000 tokens.");
	}
	return { kind: "tokens", value: tokens };
}

export function formatTarget(target: HandoffTarget): string {
	return target.kind === "percent" ? `${target.value}%` : formatTokens(target.value);
}

export function snapshotBudget(
	usage: ContextUsage | undefined,
	modelContextWindow: number | undefined,
	target: HandoffTarget,
): BudgetSnapshot {
	const contextWindow = usage?.contextWindow ?? modelContextWindow ?? null;
	// Pi can report zero before it has any provider usage. That omits the system prompt
	// and tool definitions, so presenting it as a measured empty context is misleading.
	const usedTokens = usage?.tokens === 0 ? null : (usage?.tokens ?? null);
	const targetTokens =
		target.kind === "tokens"
			? target.value
			: contextWindow === null
				? null
				: Math.round((contextWindow * target.value) / 100);

	return {
		usedTokens,
		contextWindow,
		targetTokens,
		remainingToTarget: usedTokens === null || targetTokens === null ? null : targetTokens - usedTokens,
		target,
	};
}

export function renderBudgetMessage(snapshot: BudgetSnapshot, continuationSession: boolean): string {
	const used = approximate(snapshot.usedTokens);
	const contextWindow = exact(snapshot.contextWindow);
	const targetTokens = exact(snapshot.targetTokens);
	const remaining = approximate(snapshot.remainingToTarget);
	const atOrAboveTarget = snapshot.remainingToTarget !== null && snapshot.remainingToTarget <= 0;

	const lines = [
		`[Context budget] used_tokens: ${used}; context_window: ${contextWindow}; handoff_target: ${formatTarget(snapshot.target)} (${targetTokens} tokens); remaining_to_target: ${remaining}.`,
		"Advisory only: hand off at a useful boundary, not merely because the target was reached.",
	];

	if (continuationSession && atOrAboveTarget) {
		lines.push("This continuation is already at the target; do not create another handoff solely for that reason.");
	}

	return lines.join("\n");
}

function exact(value: number | null): string {
	return value === null ? "unknown" : value.toLocaleString("en-US");
}

function approximate(value: number | null): string {
	return value === null ? "unknown" : `approximately ${value.toLocaleString("en-US")}`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
	if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
	return tokens.toLocaleString("en-US");
}
