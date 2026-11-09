/**
 * realsubagents — long-lived, module-scoped subagent groups for Pi (design: docs/design.md, route: docs/route.md).
 *
 * P0 skeleton: registers `/rsa`, which reports the version. Later phases add the coordinator
 * (orchestrator role), the member role, tools and the panel.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STATE_VERSION, VERSION } from "../../src/version.ts";

export function statusLine(): string {
	return `realsubagents ${VERSION} (state v${STATE_VERSION}): not active; see docs/route.md`;
}

export default function realsubagents(pi: ExtensionAPI): void {
	pi.registerCommand("rsa", {
		description: "realsubagents: status and control",
		handler: async (_args, ctx) => {
			ctx.ui.notify(statusLine(), "info");
		},
	});
}
