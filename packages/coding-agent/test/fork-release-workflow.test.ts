import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
	name?: string;
	run?: string;
	uses?: string;
	if?: string;
	"continue-on-error"?: boolean;
	with?: Record<string, string>;
}
interface Job {
	needs?: string | string[];
	if?: string;
	"continue-on-error"?: boolean;
	"runs-on"?: string;
	steps: Step[];
}
interface Workflow {
	jobs: Record<string, Job>;
}

const repository = resolve(__dirname, "../../..");
const forkRelease: Workflow = parse(readFileSync(join(repository, ".github/workflows/fork-release.yml"), "utf8"));

function step(job: Job, name: string): Step {
	const found = job.steps.find((entry) => entry.name === name);
	expect(found, `Missing workflow step: ${name}`).toBeDefined();
	return found!;
}

describe("fork release workflow", () => {
	it("packs stable tarballs and publishes them as GitHub release assets", () => {
		const job = forkRelease.jobs.release!;
		expect(job["runs-on"]).toBe("ubuntu-latest");
		const pack = step(job, "Pack release");
		expect(pack.run).toContain("npm run release:pack");
		expect(pack.run).toContain("--channel stable");
		expect(pack.run).toContain("--base-url");
		const publish = step(job, "Create GitHub release");
		expect(publish.run).toContain("gh release");
		const channel = step(job, "Update rolling channel manifest");
		expect(channel.run).toContain("latest.json");
		expect(channel.run).toContain("gh release upload channel");
	});
});
