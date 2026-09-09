import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
// The same command the release workflow uses to enumerate publishable platforms.
const releasePlatforms = spawnSync(process.execPath, [join(repository, "scripts/release-platforms.mjs")], {
	encoding: "utf8",
})
	.stdout.trim()
	.split("\n");
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

describe("release manifest schemas", () => {
	const manifestV1Platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
	const binaries = releasePlatforms.map((platform, index) => ({
		platform,
		file: `prime-agent-1.2.4-${platform}.tar.gz`,
		sha256: (index + 1).toString(16).padStart(64, "0"),
		executableSha256: (index + 11).toString(16).padStart(64, "0"),
	}));
	const tarballs = [
		["prime-agent-ai", "1"],
		["prime-agent-core", "2"],
		["prime-agent-tui", "3"],
		["prime-agent", "4"],
	].map(([name, hash]) => ({
		name,
		file: `${name}-1.2.4.tgz`,
		sha256: hash.repeat(64),
	}));

	it.each([
		["stable", "latest.json"],
		["beta", "beta.json"],
	] as const)("writes the %s channel with v1 and v2 binary schemas", (channel, manifestName) => {
		const directory = mkdtempSync(join(tmpdir(), "prime-release-manifest-"));
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { writeReleaseMetadata } from ${JSON.stringify(join(repository, "scripts/pack-prime-agent-release.mjs"))}; writeReleaseMetadata(${JSON.stringify(
						{
							artifactsDir: directory,
							channel,
							releaseVersion: "1.2.4",
							codingAgentTarball: "prime-agent-1.2.4.tgz",
							tarballs,
							binaries,
						},
					)});`,
				],
				{ encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);

			const manifest = JSON.parse(readFileSync(join(directory, manifestName), "utf8"));
			expect(manifest.version).toBe("v1.2.4");
			expect(manifest.tarballs).toEqual(
				tarballs.map(({ name: packageName, file, sha256 }) => ({ package: packageName, file, sha256 })),
			);
			expect(manifest.binaries.map((entry: { platform: string }) => entry.platform)).toEqual(manifestV1Platforms);
			expect(manifest.binariesV2.map((entry: { platform: string }) => entry.platform)).toEqual(releasePlatforms);
			expect(manifest.binariesV2.map((entry: { platform: string }) => entry.platform)).toEqual(
				expect.arrayContaining([
					"linux-arm64-musl",
					"linux-x64-baseline",
					"linux-x64-musl",
					"linux-x64-musl-baseline",
				]),
			);
			expect(readFileSync(join(directory, channel), "utf8")).toBe("v1.2.4\n");

			const expectedChecksums = [...tarballs, ...binaries]
				.map((artifact) => `${artifact.sha256}  ${artifact.file}`)
				.join("\n");
			expect(readFileSync(join(directory, "SHA256SUMS"), "utf8")).toBe(`${expectedChecksums}\n`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
