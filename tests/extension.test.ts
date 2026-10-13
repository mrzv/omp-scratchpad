import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent";
import { getMarkdownTheme, getThemeByName, setThemeInstance, theme, visibleWidth, type Component, type TUI } from "@oh-my-pi/pi-tui";
import scratchpad from "../src/extension.ts";

type Handler = (event: unknown, ctx: ExtensionCommandContext) => void | Promise<void>;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(durable = false) {
	getMarkdownTheme();
	const directory = await mkdtemp(join(tmpdir(), "omp-scratchpad-test-"));
	const managers = [durable ? SessionManager.create(directory, directory) : SessionManager.inMemory(directory)];
	let manager = managers[0]!;
	let response: string | undefined | Promise<string | undefined>;
	let prefill = "";
	let prompt = "existing draft: ";
	const widgets = new Map<string, Component | string[] | undefined>();
	const notices: string[] = [];
	const events = new Map<string, Handler>();
	let command: Command;
	let shortcut: (ctx: ExtensionCommandContext) => Promise<void>;
	const ctx = {
		get sessionManager() { return manager; },
		hasUI: true,
		ui: {
			supportsEditor: true,
			editor: async (_title: string, value: string) => { prefill = value; return await response; },
			setWidget: (key: string, content: ExtensionWidgetContent) => {
				widgets.set(key, typeof content === "function" ? content({} as TUI, theme) : content);
			},
			notify: (message: string) => { notices.push(message); },
			pasteToEditor: (text: string) => { prompt += text; },
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		on: (event: string, handler: Handler) => { events.set(event, handler); },
		appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); },
		registerCommand: (_name: string, spec: { handler: Command }) => { command = spec.handler; },
		registerShortcut: (_key: string, spec: { handler: typeof shortcut }) => { shortcut = spec.handler; },
	} as unknown as ExtensionAPI;
	scratchpad(pi);
	const emit = async (name: string) => { await events.get(name)?.({}, ctx); };
	await emit("session_start");
	cleanups.push(async () => {
		for (const item of managers) await item.close();
		await rm(directory, { recursive: true, force: true });
	});
	return {
		ctx, notices,
		get manager() { return manager; },
		get prefill() { return prefill; },
		get prompt() { return prompt; },
		preview(width = 80) {
			const content = widgets.get("omp-scratchpad.preview");
			return Array.isArray(content) ? content : content?.render(width);
		},
		invalidatePreview() {
			const content = widgets.get("omp-scratchpad.preview");
			if (content && !Array.isArray(content)) content.invalidate?.();
		},
		set response(value: typeof response) { response = value; },
		run: (args = "") => command(args, ctx),
		emit,
		shortcut: () => shortcut(ctx),
		async switchTo(file?: string) {
			manager = file ? await SessionManager.open(file, directory) : SessionManager.inMemory(directory);
			managers.push(manager);
			await emit("session_switch");
		},
	};
}

describe("personal scratchpad", () => {
	test("notes-only sessions survive reopen; clearing persists an empty note", async () => {
		const f = await fixture(true);
		f.response = "private\nnotes";
		await f.run();
		const file = f.manager.getSessionFile()!;
		await f.manager.close();
		await f.switchTo(file);
		f.response = undefined;
		await f.shortcut();
		expect(f.prefill).toBe("private\nnotes");
		f.response = "";
		await f.run();
		await f.manager.close();
		await f.switchTo(file);
		f.response = undefined;
		await f.run();
		expect(f.prefill).toBe("");
	});

	test("an unchanged save retries a failed disk write without losing the note", async () => {
		const f = await fixture(true);
		const file = f.manager.getSessionFile()!;
		const directory = dirname(file);
		const displaced = `${directory}-backup`;
		await rename(directory, displaced);
		await writeFile(directory, "block session writes");
		f.response = "note that must survive restart";
		try {
			await expect(f.run()).rejects.toThrow();
		} finally {
			await rm(directory);
			await rename(displaced, directory);
		}
		await f.run();
		await f.manager.close();
		await f.switchTo(file);
		f.response = undefined;
		await f.run();
		expect(f.prefill).toBe("note that must survive restart");
	});

	test("cancel leaves the note unchanged and never enters automatic model context", async () => {
		const f = await fixture();
		f.manager.appendMessage({ role: "user", content: "public question", timestamp: 1 });
		const before = f.manager.buildSessionContext().messages;
		f.response = "PRIVATE_SENTINEL";
		await f.run();
		await f.run("preview");
		f.response = undefined;
		await f.run();
		expect(f.prefill).toBe("PRIVATE_SENTINEL");
		expect(f.manager.buildSessionContext().messages).toEqual(before);
		expect(f.prompt).toBe("existing draft: ");
	});

	test("branches inherit notes and diverge, with previews restored on navigation", async () => {
		const f = await fixture();
		f.response = "root note";
		await f.run();
		await f.run("preview");
		const root = f.manager.getLeafId()!;
		f.response = "left note";
		await f.run();
		const left = f.manager.getLeafId()!;
		f.manager.branch(root);
		await f.emit("session_tree");
		expect(f.preview()?.join("\n")).toContain("root note");
		f.response = "right note";
		await f.run();
		expect(f.preview()?.join("\n")).toContain("right note");
		f.manager.branch(left);
		await f.emit("session_tree");
		expect(f.preview()?.join("\n")).toContain("left note");
		f.response = undefined;
		await f.run();
		expect(f.prefill).toBe("left note");
	});

	test("new sessions start empty and remove the previous session's preview", async () => {
		const f = await fixture();
		f.response = "old session";
		await f.run();
		await f.run("preview");
		await f.switchTo();
		expect(f.preview()).toBeUndefined();
		f.response = undefined;
		await f.run();
		expect(f.prefill).toBe("");
	});

	test("Markdown preview stays bounded when long content wraps at narrow widths", async () => {
		const f = await fixture();
		f.response = `# Plan\n\n${"Compare approaches carefully. ".repeat(200)}\n\nHIDDEN_TAIL`;
		await f.run();
		await f.run("preview");
		for (const width of [20, 80]) {
			const rows = f.preview(width)!;
			expect(rows.length).toBeLessThanOrEqual(9);
			expect(rows.join("\n")).not.toContain("HIDDEN_TAIL");
			expect(rows.join("\n")).toContain("…");
		}
	});

	test("Markdown entities cannot introduce terminal controls into the preview", async () => {
		const f = await fixture();
		for (const note of [
			"&#27;[2J",
			"&#2&#0;7;[2J",
			"<p>&#2<!--x-->7;[2J</p>",
			"prefix <code>&\\#27;[2J</code>",
			"prefix <code>&**#27**;[2J</code>",
			"<span>&#x1b;]52;c;SECRET&#7;</span>",
			"[&#x9b;2J](https://example.com)",
			"&amp;#27;[2J",
			"&#38;#27;[2J",
			"&#38;&#35;27;[2J",
			"&#x26;&#x23;&#x32;&#x37;;[2J",
		]) {
			f.response = note;
			await f.run();
			if (!f.preview()) await f.run("preview");
			expect(f.preview()!.join("\n")).not.toMatch(/\x1b\[2J|\x1b\]52;|\x9b/);
		}
	});

	test("filtered terminal controls cannot widen preview rows beyond the widget width", async () => {
		const f = await fixture();
		f.response = "A&#27;[2JB&#27;[2JC";
		await f.run();
		await f.run("preview");
		for (const width of [20, 80]) {
			expect(f.preview(width)!.every(row => visibleWidth(row) <= width)).toBe(true);
		}
	});

	test("preview invalidation follows theme color changes", async () => {
		const f = await fixture();
		f.response = "> A quoted note";
		await f.run();
		await f.run("preview");
		const previousTheme = theme;
		try {
			setThemeInstance((await getThemeByName("light"))!);
			f.invalidatePreview();
			const header = f.preview()![0]!;
			expect(header).toBe(theme.fg("muted", Bun.stripANSI(header)));
		} finally {
			setThemeInstance(previousTheme);
		}
	});

	for (const transition of ["session_switch", "session_tree"] as const) {
		test(`an editor spanning ${transition} cannot write into its new target`, async () => {
			const f = await fixture();
			const { promise, resolve: finish } = Promise.withResolvers<string | undefined>();
			f.response = promise;
			const pending = f.run();
			if (transition === "session_switch") await f.switchTo();
			else {
				f.manager.resetLeaf();
				await f.emit(transition);
			}
			finish("wrong target");
			await pending;
			expect(f.manager.getBranch()).toEqual([]);
		});
	}
});
