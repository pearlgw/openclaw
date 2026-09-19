import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import corePackagePolicy from "../../scripts/lib/npm-core-release-packages.json" with { type: "json" };
import {
  createPublishPreflightEvidenceClient,
  validatePublishPreflightNpm,
  verifyPublishAndroidPin,
  verifyPublishedPreflightTarball,
} from "../../scripts/lib/release-publish-preflight-evidence.mts";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv, writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.5";
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function coreEvidenceFixture(androidPin: unknown = { version }) {
  const source = tempDirs.make("publish-preflight-source-");
  const artifacts = tempDirs.make("publish-preflight-artifacts-");
  writeJsonFile(join(source, "package.json"), {
    name: "openclaw",
    version,
    dependencies: { "@openclaw/ai": "workspace:*" },
  });
  writeJsonFile(join(source, "apps/android/version.json"), androidPin);
  for (const policy of corePackagePolicy) {
    writeJsonFile(join(source, policy.path, "package.json"), {
      name: policy.name,
      version,
      openclaw: { release: { publishToNpm: true } },
    });
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        source,
        "-c",
        "user.name=Release fixture",
        "-c",
        "user.email=release-fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "release source fixture");
  const targetSha = git("rev-parse", "HEAD");
  vi.stubEnv("GIT_DIR", join(source, ".git"));
  vi.stubEnv("GIT_WORK_TREE", source);
  const corePackages = corePackagePolicy.map((policy) => {
    const tarballName = `${policy.name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
    const bytes = Buffer.from(`synthetic immutable ${policy.name}`);
    writeFileSync(join(artifacts, tarballName), bytes);
    return {
      packageName: policy.name,
      packageVersion: version,
      tarballName,
      tarballSha256: sha256(bytes),
    };
  });
  const rootBytes = Buffer.from("synthetic immutable openclaw");
  writeFileSync(join(artifacts, "openclaw.tgz"), rootBytes);
  writeFileSync(
    join(artifacts, "core-packages-SHA256SUMS"),
    corePackages.map((entry) => `${entry.tarballSha256}  ${entry.tarballName}\n`).join(""),
  );
  const payload = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
  const manifest = {
    version: 1,
    releaseTag: `v${version}`,
    releaseSha: targetSha,
    packageVersion: version,
    npmDistTag: "latest",
    tarballName: "openclaw.tgz",
    tarballSha256: sha256(rootBytes),
    corePackageTarballs: corePackages,
    dependencyTarballs: [corePackages[0]],
    pluginSdkApi: createPluginSdkApiReleaseEvidence({
      baseRef: "v2026.8.1",
      baseSha: "b".repeat(40),
      headSha: targetSha,
      workflowSha: targetSha,
      diff: { ...payload, digest: sha256(JSON.stringify(payload)) },
    }),
  };
  const manifestPath = join(artifacts, "preflight-manifest.json");
  const writeManifest = () => writeJsonFile(manifestPath, manifest);
  writeManifest();
  const runGh = (args: string[]) => {
    if (args[1]?.includes("/compare/")) {
      return JSON.stringify({ status: "identical" });
    }
    if (args[1] === "repos/openclaw/openclaw/actions/runs/2") {
      return JSON.stringify({
        id: 2,
        path: ".github/workflows/openclaw-npm-release.yml",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: targetSha,
        run_attempt: 1,
      });
    }
    throw new Error(`Unexpected GitHub request: ${args.join(" ")}`);
  };
  return {
    source,
    targetSha,
    artifacts,
    corePackages,
    manifest,
    writeManifest,
    verify: () =>
      validatePublishPreflightNpm(
        {
          repo: "openclaw/openclaw",
          tag: `v${version}`,
          targetSha,
          toolingSha: targetSha,
          workflowRef: `release-publish/${targetSha.slice(0, 12)}-123`,
          npmDistTag: "latest",
          preflightRunId: "2",
          fullReleaseValidationRunId: "1",
          fullReleaseValidationRunAttempt: "1",
          pluginSdkApiAcknowledgement: "",
          currentSelectorRef: `v${version}`,
          currentSelectorSha: targetSha,
          runGh,
        },
        { npmManifest: manifest, npmManifestPath: manifestPath },
      ),
  };
}

describe("publish preflight immutable npm evidence", () => {
  it.each(["2026.9.0", "2026.12.999"])("reads Android pin %s from the immutable source", (pin) => {
    const fixture = coreEvidenceFixture({ version: pin });
    writeJsonFile(join(fixture.source, "apps/android/version.json"), {
      version: "changed locally",
    });
    expect(verifyPublishAndroidPin({ sourceSha: fixture.targetSha })).toBe(pin);
  });

  it.each([undefined, 2026, "2026.0.1", "2026.13.1", "2026.9.1000", "2026.9.5-beta.1"])(
    "rejects an invalid Android pin before publication: %j",
    (pin) => {
      const fixture = coreEvidenceFixture({ version: pin });
      expect(() => verifyPublishAndroidPin({ sourceSha: fixture.targetSha })).toThrow(
        "must pin an exact YYYY.M.PATCH",
      );
    },
  );

  it("qualifies the complete prepared core package set against exact source metadata", () => {
    const fixture = coreEvidenceFixture();
    expect(fixture.verify().corePackages).toEqual(fixture.corePackages);
  });

  it.each([
    ["missing required package", "missing from the manifest"],
    ["corrupt core bytes", "digest mismatch"],
    ["duplicate core descriptor", "duplicate prepared core package"],
    ["invalid checksums", "checksum verification failed"],
    ["changed reused manifest", "changed after candidate validation"],
    ["changed reused root bytes", "wrong digest"],
  ])("rejects %s before publication", (mode, message) => {
    const fixture = coreEvidenceFixture();
    if (mode === "missing required package") {
      fixture.manifest.corePackageTarballs = fixture.corePackages.slice(0, -1);
    }
    if (mode === "duplicate core descriptor") {
      fixture.manifest.corePackageTarballs = [fixture.corePackages[0]!, fixture.corePackages[0]!];
    }
    fixture.writeManifest();
    if (mode === "corrupt core bytes") {
      writeFileSync(
        join(fixture.artifacts, fixture.corePackages[1]!.tarballName),
        "changed core bytes",
      );
    }
    if (mode === "invalid checksums") {
      writeFileSync(join(fixture.artifacts, "core-packages-SHA256SUMS"), "broken\n");
    }
    if (mode === "changed reused manifest") {
      fixture.manifest.tarballName = "changed.tgz";
    }
    if (mode === "changed reused root bytes") {
      writeFileSync(join(fixture.artifacts, "openclaw.tgz"), "changed root bytes");
    }
    expect(() => fixture.verify()).toThrow(message);
  });

  it.each([
    ["exact bytes", undefined],
    ["byte conflict", "different from this preflight"],
    ["foreign origin", "canonical registry origin"],
    ["wrong version", "identity differs"],
  ])("verifies published core resume using %s", async (mode, message) => {
    const bytes = Buffer.from("synthetic published core tarball");
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.endsWith(".tgz")) {
        return new Response(mode === "byte conflict" ? "changed bytes" : bytes);
      }
      return Response.json({
        name: "openclaw",
        versions: {
          [version]: {
            name: "openclaw",
            version: mode === "wrong version" ? "2026.9.4" : version,
            dist: {
              tarball:
                mode === "foreign origin"
                  ? "https://example.invalid/package.tgz"
                  : `https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`,
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const result = verifyPublishedPreflightTarball({
      packageName: "openclaw",
      version,
      tarballSha256: sha256(bytes),
    });
    if (message) {
      await expect(result).rejects.toThrow(message);
    } else {
      await expect(result).resolves.toBeUndefined();
    }
    if (mode === "foreign origin") {
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.skipIf(process.platform === "win32")(
    "downloads each exact validation attempt once and verifies its artifact digest",
    async () => {
      const directory = tempDirs.make("publish-preflight-manifest-");
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const downloads = join(directory, "downloads");
      writeFileSync(downloads, "");
      const manifests = [1, 2].map((attempt) => ({
        version: 4,
        workflowName: "Full Release Validation",
        runId: "123",
        runAttempt: String(attempt),
      }));
      const artifacts = await Promise.all(
        manifests.map(async (manifest, index) => {
          const archive = await new JSZip()
            .file("full-release-validation-manifest.json", JSON.stringify(manifest))
            .generateAsync({ type: "nodebuffer", compression: "STORE", platform: "UNIX" });
          const id = 90 + index;
          writeFileSync(join(directory, `${id}.zip`), archive);
          return {
            id,
            name: `full-release-validation-123-${index + 1}`,
            expired: false,
            digest: `sha256:${sha256(archive)}`,
            size_in_bytes: archive.length,
            workflow_run: { id: 123 },
          };
        }),
      );
      writeFileSync(
        join(bin, "gh"),
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const endpoint = args[1];
const artifacts = ${JSON.stringify(artifacts)};
if (args[0] !== "api") throw new Error("Unexpected gh command");
if (endpoint.includes("/actions/runs/123/artifacts?")) process.stdout.write(JSON.stringify({ artifacts }));
else {
  const match = new RegExp("/actions/artifacts/(90|91)(/zip)?$").exec(endpoint);
  if (!match) throw new Error("Unexpected endpoint: " + endpoint);
  if (match[2]) {
    fs.appendFileSync(${JSON.stringify(downloads)}, match[1] + "\\n");
    process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(directory)}, match[1] + ".zip")));
  } else process.stdout.write(JSON.stringify(artifacts.find(entry => String(entry.id) === match[1])));
}
`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("OPENCLAW_GH_BIN", "");
      const client = createPublishPreflightEvidenceClient("openclaw/openclaw");
      expect(client.loadManifest("123", 1)?.manifest).toEqual(manifests[0]);
      writeFileSync(join(directory, "90.zip"), "changed after the authenticated read");
      expect(client.loadManifest("123", 1)?.manifest).toEqual(manifests[0]);
      expect(client.loadManifest("123", 2)?.manifest).toEqual(manifests[1]);
      expect(readFileSync(downloads, "utf8").trim().split("\n")).toEqual(["90", "91"]);
    },
  );
});
