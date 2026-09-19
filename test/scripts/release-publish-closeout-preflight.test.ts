import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyStableMainCloseout } from "../../scripts/lib/stable-release-closeout.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tag = "v2026.9.5";
const section = "## 2026.9.5\n\n### Changes\n\n- Synthetic release proof.\n";
const checksum = (name: string, bytes: string) =>
  `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;

function closeoutFixture(changelog = `# Changelog\n\n${section}`) {
  const dir = tempDirs.make("preflight-closeout-source-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release fixture",
        "-c",
        "user.email=release-fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.9.5" }));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  writeFileSync(join(dir, "appcast.xml"), "<rss/>");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const sha = git("rev-parse", "HEAD");
  const moduleUrl = new URL(
    "../../scripts/lib/release-publish-closeout-preflight.mts",
    import.meta.url,
  ).href;
  return {
    sha,
    inspect(responses: Record<string, unknown>, notes = false) {
      return JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
import { inspectStableCloseoutPreflight, inspectPublishReleasePage } from ${JSON.stringify(moduleUrl)};
const responses=${JSON.stringify(responses)}, reads=[];
const input={repo:'openclaw/openclaw',tag:${JSON.stringify(tag)},sourceSha:${JSON.stringify(sha)},attempt:'1',runId:'123',runGh(args){
  reads.push(args[1]);
  const key=args[1].replace('repos/openclaw/openclaw/','');
  if (!Object.hasOwn(responses,key)) throw new Error('HTTP 404: '+key);
  return typeof responses[key]==='string'?responses[key]:JSON.stringify(responses[key]);
}};
try {console.log(JSON.stringify({rows:await ${notes ? "inspectPublishReleasePage" : "inspectStableCloseoutPreflight"}(input),reads}));}
catch(error){console.log(JSON.stringify({error:error.message,reads}));}
`,
          ],
          { cwd: dir, env: createNestedGitEnv(), encoding: "utf8", timeout: 30_000 },
        ),
      ) as {
        rows?: { id: string; status: string; message: string }[];
        error?: string;
        reads: string[];
      };
    },
  };
}

function recordedCloseout(fixture: ReturnType<typeof closeoutFixture>, mode: string) {
  const postName = "openclaw-2026.9.5-postpublish-evidence.json";
  const receiptName = "openclaw-2026.9.5-stable-main-closeout.json";
  const fullName = "openclaw-2026.9.5-release-manifest.json";
  const contents: Record<string, string> = {};
  const assets: { id: number; name: string; digest: string }[] = [];
  const addAsset = (name: string, bytes: string) => {
    const id = assets.length + 1;
    assets.push({ id, name, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
    contents[`releases/assets/${id}`] = bytes;
  };
  const post = JSON.stringify({
    releaseTag: tag,
    releaseVersion: "2026.9.5",
    releaseSha: fixture.sha,
    releasePublishRunId: "456",
    workflowRuns: [{ label: "Full Release Validation", id: "123", runAttempt: "1" }],
    ...(mode === "recorded soak waiver"
      ? { stableSoakWaiver: "Operator approved the retained evidence." }
      : {}),
  });
  addAsset(postName, post);
  addAsset(`${postName}.sha256`, checksum(postName, post));
  const full = JSON.stringify({
    workflowName: "Full Release Validation",
    runId: "123",
    runAttempt: mode === "wrong attached validation attempt" ? "2" : "1",
    targetSha: fixture.sha,
    rerunGroup: "all",
    runReleaseSoak: mode === "recorded soak waiver" ? "false" : "true",
    controls: {
      performanceBlocking: mode !== "unpassed attached controls" && mode !== "recorded soak waiver",
    },
    childRuns: { productPerformance: { conclusion: "success" } },
  });
  addAsset(fullName, full);
  if (mode !== "missing validation checksum") {
    addAsset(
      `${fullName}.sha256`,
      mode === "bad validation checksum"
        ? `${"0".repeat(64)}  ${fullName}\n`
        : checksum(fullName, full),
    );
  }
  const result = verifyStableMainCloseout({
    tag,
    mainPackageJson: { version: "2026.9.5" },
    tagPackageJson: { version: "2026.9.5" },
    mainRelease: { section },
    tagRelease: { section },
    mainAppcast: "<rss/>",
    release: { tagName: tag, isDraft: false, isPrerelease: false, assets },
    releaseTagSha: fixture.sha,
    mainSha: fixture.sha,
    fullReleaseValidationRunId: "123",
    fullReleaseValidationRunAttempt: "1",
    releasePublishRunId: "456",
    rollbackDrillId: "recorded-drill",
    rollbackDrillDate: "2025-01-01",
    nowMs: Date.parse("2025-01-02"),
  });
  expect(result.errors).toEqual([]);
  const receipt = {
    ...result.manifest!,
    ...(mode === "unproved split recovery"
      ? { releasePublishRecovery: { mode: "split-publication-v1" } }
      : {}),
  };
  if (mode === "malformed schema") {
    receipt.version = 1;
  }
  if (mode === "wrong validation") {
    receipt.fullReleaseValidationRunId = "789";
  }
  if (mode === "wrong publisher") {
    receipt.releasePublishRunId = "789";
  }
  const bytes = JSON.stringify(receipt);
  if (mode !== "checksum without receipt") {
    addAsset(receiptName, bytes);
  }
  if (mode !== "missing checksum") {
    addAsset(
      `${receiptName}.sha256`,
      mode === "bad checksum"
        ? `${"0".repeat(64)}  ${receiptName}\n`
        : checksum(receiptName, bytes),
    );
  }
  return {
    ...contents,
    "git/ref/heads/main": { object: { sha: fixture.sha } },
    [`releases/tags/${tag}`]: { tag_name: tag, draft: false, prerelease: false, assets },
  };
}

describe("publication preflight closeout phase", () => {
  it("reports pending main reconciliation without making it a publication prerequisite", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-closeout-readiness-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: dir,
          env: createNestedGitEnv(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      git("init", "-q");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.9.4" }));
      git("add", "package.json");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      );
      const sha = git("rev-parse", "HEAD").trim();
      const moduleUrl = new URL(
        "../../scripts/lib/release-publish-closeout-preflight.mts",
        import.meta.url,
      ).href;
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { inspectStableCloseoutPreflight } from ${JSON.stringify(moduleUrl)};
        const sha=${JSON.stringify(sha)};
        const rows=await inspectStableCloseoutPreflight({repo:'openclaw/openclaw',tag:'v2026.9.5',sourceSha:sha,attempt:'1',runId:'123',runGh(args){
          if(args[1].endsWith('git/ref/heads/main')) return JSON.stringify({object:{sha}});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_ID')) return JSON.stringify({value:'verified-fixture-drill'});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_DATE')) return JSON.stringify({value:new Date(Date.now()-86400000).toISOString().slice(0,10)});
          if(args[1].includes('/releases/tags/')) throw new Error('HTTP 404');
          throw new Error('Unexpected read '+args[1]);
        }});
        console.log(JSON.stringify(rows));
      `,
          ],
          { cwd: dir, encoding: "utf8" },
        ),
      );
      expect(result).toContainEqual(
        expect.objectContaining({ id: "stable-closeout.main-source", status: "WARN" }),
      );
      expect(result).not.toContainEqual(expect.objectContaining({ status: "FAIL" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["valid", "PASS"],
    ["missing checksum", "WARN"],
    ["bad checksum", "FAIL"],
    ["checksum without receipt", "FAIL"],
    ["malformed schema", "FAIL"],
    ["wrong validation", "FAIL"],
    ["wrong publisher", "FAIL"],
    ["missing validation checksum", "FAIL"],
    ["bad validation checksum", "FAIL"],
    ["wrong attached validation attempt", "FAIL"],
    ["unpassed attached controls", "FAIL"],
    ["recorded soak waiver", "PASS"],
    ["unproved split recovery", "FAIL"],
  ])("checks existing %s closeout evidence before replay", (mode, status) => {
    const fixture = closeoutFixture();
    const result = fixture.inspect(recordedCloseout(fixture, mode));
    expect(result.error).toBeUndefined();
    expect(result.rows).toContainEqual(
      expect.objectContaining({ id: "stable-closeout.existing-receipt", status }),
    );
    if (mode === "unproved split recovery") {
      expect(result.rows).toContainEqual(
        expect.objectContaining({
          id: "stable-closeout.existing-receipt",
          status: "FAIL",
          message: expect.stringContaining("Stable publish recovery: invalid run or attempt ID."),
        }),
      );
    }
    if (mode === "valid" || mode === "missing checksum") {
      expect(result.rows).not.toContainEqual(expect.objectContaining({ status: "FAIL" }));
      expect(result.reads.some((read) => read.includes("actions/variables"))).toBe(false);
    }
  });

  it.each(["# Changelog\n", "# Changelog\n\n## 2026.9.4\n\n- Wrong release.\n"])(
    "rejects absent release notes before checking an absent GitHub release",
    (changelog) => {
      const fixture = closeoutFixture(changelog);
      const result = fixture.inspect({}, true);
      expect(result.error).toBeTruthy();
      expect(result.reads).toEqual([]);
    },
  );
});
