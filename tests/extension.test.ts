import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import scratchpad from "../src/extension.ts";

type Handler = (event: unknown, ctx: ExtensionCommandContext) => void | Promise<void>;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(durable = false) {
	const directory = await mkdtemp(join(tmpdir(), "omp-scratchpad-test-"));
	const managers = [durable ? SessionManager.create(directory, directory) : SessionManager.inMemory(directory)];
	let manager = managers[0]!;
	let response: string | undefined | Promise<string | undefined>;
	let prefill = "";
	let prompt = "existing draft: ";
	const widgets = new Map<string, string[] | undefined>();
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
			setWidget: (key: string, content: string[] | undefined) => { widgets.set(key, content); },
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
		get preview() { return widgets.get("omp-scratchpad.preview"); },
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
		expect(f.preview).toContain("root note");
		f.response = "right note";
		await f.run();
		expect(f.preview).toContain("right note");
		f.manager.branch(left);
		await f.emit("session_tree");
		expect(f.preview).toContain("left note");
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
		expect(f.preview).toBeUndefined();
		f.response = undefined;
		await f.run();
		expect(f.prefill).toBe("");
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
