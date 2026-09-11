import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	buildIncomingNote,
	collectUserMessages,
	createUserTicket,
	findFirstResponseFailure,
	findSoleHandoffToolCall,
	renderIncomingNote,
	validateHandoffMessage,
	validateSourceBoundary,
} from "../src/handoff.ts";
import type { HandoffTicket } from "../src/store.ts";

function entries(...values: unknown[]): SessionEntry[] {
	return values as SessionEntry[];
}

function assistant(id: string, calls: Array<{ id: string; name: string }>) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
		},
	};
}

function ticket(overrides: Partial<HandoffTicket> = {}): HandoffTicket {
	return {
		version: 1,
		id: "00000000-0000-4000-8000-000000000001",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		status: "accepted",
		author: "agent",
		sourceSessionId: "source-id",
		sourceSessionFile: "/sessions/source.jsonl",
		sourceBoundaryEntryId: "assistant-entry",
		toolCallId: "handoff-call",
		message: "Continue the work.",
		userMessages: ["Keep the API stable."],
		...overrides,
	};
}

describe("handoff call boundary", () => {
	it("accepts a handoff-only tool message", () => {
		expect(findSoleHandoffToolCall(entries(assistant("assistant-entry", [{ id: "handoff-call", name: "handoff" }])), "handoff-call"))
			.toBe("assistant-entry");
	});

	it("rejects mixed tool batches", () => {
		const branch = entries(
			assistant("assistant-entry", [
				{ id: "read-call", name: "read" },
				{ id: "handoff-call", name: "handoff" },
			]),
		);
		expect(() => findSoleHandoffToolCall(branch, "handoff-call")).toThrow("only tool call");
	});

	it("invalidates a request when new user context appears after its result", () => {
		const branch = entries(
			assistant("assistant-entry", [{ id: "handoff-call", name: "handoff" }]),
			{
				type: "message",
				id: "result-entry",
				message: { role: "toolResult", toolCallId: "handoff-call", toolName: "handoff" },
			},
			{ type: "message", id: "new-user", message: { role: "user", content: "Wait" } },
		);
		expect(validateSourceBoundary(branch, ticket())).toEqual({
			valid: false,
			reason: "The source session received or processed new context after the handoff request.",
		});
	});

	it("accepts exactly one matching handoff result and non-context metadata", () => {
		const branch = entries(
			assistant("assistant-entry", [{ id: "handoff-call", name: "handoff" }]),
			{ type: "custom", id: "metadata", customType: "other-extension" },
			{
				type: "message",
				id: "result-entry",
				message: { role: "toolResult", toolCallId: "handoff-call", toolName: "handoff" },
			},
		);
		expect(validateSourceBoundary(branch, ticket())).toEqual({ valid: true });
	});
});

describe("handoff message", () => {
	it("rejects empty task-state notes without imposing a size budget", () => {
		expect(() => validateHandoffMessage("  \n")).toThrow("must not be empty");
		expect(() => validateHandoffMessage("x".repeat(128 * 1024))).not.toThrow();
	});

	it("labels the note as Agent-authored continuity rather than authorization", () => {
		const rendered = renderIncomingNote("Next step: run the focused test.");
		expect(rendered).toContain("# Session handoff");
		expect(rendered).toContain("Agent-authored task state");
		expect(rendered).toContain("not a new user instruction or authorization");
		expect(rendered).toContain("Next step: run the focused test.");
	});

	it("identifies a directly written user note without turning it into a chat message", () => {
		const rendered = renderIncomingNote("Continue with the requested focus.", "user");
		expect(rendered).toContain("User-written task state from /handoff --write");
		expect(rendered).toContain("not a new chat message");
	});

	it("preserves every source user message in chronological order", () => {
		const preserved = collectUserMessages(
			entries(
				{ type: "message", id: "u1", message: { role: "user", content: "First exact message." } },
				assistant("a1", []),
				{
					type: "message",
					id: "u2",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "Second exact message." },
							{ type: "image", mimeType: "image/png", data: "ignored-in-note" },
						],
					},
				},
			),
		);
		expect(preserved).toEqual([
			"First exact message.",
			"Second exact message.[Image attachment (image/png); binary remains in the source session]",
		]);
		const rendered = renderIncomingNote("Concise state.", "agent", preserved);
		expect(rendered).toContain("## User message archive (2)");
		expect(rendered.indexOf("First exact message.")).toBeLessThan(rendered.indexOf("Second exact message."));
	});

	it("carries inherited messages across repeated handoffs without nesting rendered notes", () => {
		const inherited = buildIncomingNote({
			id: "previous-handoff",
			sourceSessionFile: "/sessions/original.jsonl",
			author: "agent",
			message: "Previous concise state.",
			userMessages: ["Original request.", "Original follow-up."],
		});
		const preserved = collectUserMessages(
			entries(
				{
					type: "custom_message",
					id: "incoming-note",
					customType: "pi-handoff-note",
					content: inherited.content,
					details: inherited.details,
					display: true,
				},
				{ type: "message", id: "new-user", message: { role: "user", content: "New follow-up." } },
			),
		);
		expect(preserved).toEqual(["Original request.", "Original follow-up.", "New follow-up."]);
		expect(preserved).not.toContain(inherited.content);
	});

	it("migrates the previous note format so existing continuations keep their inherited messages", () => {
		const legacyContent = [
			"[Agent-authored continuation context; not a new user instruction or authorization]",
			"",
			"[Concise task state]",
			"Continue the existing task.",
			"",
			"[Source user messages — chronological, verbatim text]",
			"--- User message 1 ---",
			"Original request.",
			"",
			"--- User message 2 ---",
			"Follow-up request.",
		].join("\n");
		expect(collectUserMessages(entries({
			type: "custom_message",
			id: "legacy-note",
			customType: "pi-handoff-note",
			content: legacyContent,
			details: { version: 1, authoredBy: "agent" },
			display: true,
		}))).toEqual(["Original request.", "Follow-up request."]);
	});

	it("round-trips long messages exactly through range metadata", () => {
		const longMessage = `prefix\n${"很长的内容🙂".repeat(20_000)}\nsuffix`;
		const incoming = buildIncomingNote({
			id: "long-handoff",
			sourceSessionFile: "/sessions/source.jsonl",
			author: "agent",
			message: "Concise state.",
			userMessages: [longMessage],
		});
		expect(collectUserMessages(entries({
			type: "custom_message",
			id: "incoming-note",
			customType: "pi-handoff-note",
			content: incoming.content,
			details: incoming.details,
			display: true,
		}))).toEqual([longMessage]);
	});

	it("recognizes resolved assistant errors as failed first responses", () => {
		expect(
			findFirstResponseFailure(
				entries({
					type: "message",
					id: "failed-response",
					message: { role: "assistant", content: [], stopReason: "error", errorMessage: "No credentials" },
				}),
			),
		).toContain("No credentials");
		expect(findFirstResponseFailure([])).toContain("No assistant response");
		expect(
			findFirstResponseFailure(
				entries({
					type: "message",
					id: "successful-response",
					message: { role: "assistant", content: [], stopReason: "stop" },
				}),
			),
		).toBeUndefined();
	});

	it("rejects direct handoff from an allocated but not yet durable source session", async () => {
		const createTicket = vi.fn();
		await expect(
			createUserTicket(
				"Continue later.",
				{
					sessionManager: {
						getSessionFile: () => "/sessions/allocated-but-unwritten.jsonl",
						getBranch: () => [],
					},
				} as any,
				{ createTicket } as any,
			),
		).rejects.toThrow("persisted source session with an assistant turn");
		expect(createTicket).not.toHaveBeenCalled();
	});
});
