import { describe, expect, it } from "vitest";
import { buildIncomingNote } from "../src/handoff.ts";
import { renderHandoffNote } from "../src/render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

describe("handoff note renderer", () => {
	it("keeps long user messages compact by default and reveals them when expanded", () => {
		const longMessage = `${"long message content ".repeat(2_000)}UNIQUE_END`;
		const incoming = buildIncomingNote({
			id: "handoff-id",
			sourceSessionFile: "/sessions/source.jsonl",
			author: "agent",
			message: "Continue the focused implementation.",
			userMessages: [longMessage, "Short follow-up."],
		});
		const message = { content: incoming.content, details: incoming.details };

		const collapsed = renderHandoffNote(message, { expanded: false, outputPad: 1 }, theme)?.render(100).join("\n");
		expect(collapsed).toContain("2 user messages preserved verbatim");
		expect(collapsed).toContain("Expand output to view the complete verbatim archive.");
		expect(collapsed).not.toContain("UNIQUE_END");

		const expanded = renderHandoffNote(message, { expanded: true, outputPad: 1 }, theme)?.render(100).join("\n");
		expect(expanded).toContain("User message 1 of 2");
		expect(expanded).toContain("UNIQUE_END");
		expect(expanded).toContain("Short follow-up.");
	});
});
