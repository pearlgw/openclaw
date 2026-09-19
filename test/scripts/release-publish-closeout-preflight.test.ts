import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const moduleUrl = new URL(
  "../../scripts/lib/release-publish-closeout-preflight.mts",
  import.meta.url,
).href;

function sourceFixture(changelog?: string) {
  const dir = tempDirs.make("release-closeout-readiness-");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: createNestedGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.9.4" }));
  if (changelog !== undefined) {
    writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  }
  git("add", ".");
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
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}

describe("publication preflight closeout phase", () => {
  it("reports pending main reconciliation without making it a publication prerequisite", () => {
    const { dir, sha } = sourceFixture();
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { inspectStableCloseoutPreflight } from ${JSON.stringify(moduleUrl)};
        const sha=${JSON.stringify(sha)};
        const rows=inspectStableCloseoutPreflight({repo:'openclaw/openclaw',tag:'v2026.9.5',sourceSha:sha,attempt:'1',runId:'123',runGh(args){
          if(args[1].endsWith('git/ref/heads/main')) return JSON.stringify({object:{sha}});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_ID')) return JSON.stringify({value:'verified-fixture-drill'});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_DATE')) return JSON.stringify({value:new Date(Date.now()-86400000).toISOString().slice(0,10)});
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
  });

  it.each(["absent", "draft"])(
    "validates frozen release notes before admitting an %s release page",
    (releaseState) => {
      const { dir, sha } = sourceFixture(
        `## 2026.9.5\n\n${"oversized release notes ".repeat(6_000)}`,
      );
      const inspect = () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
                import { inspectPublishReleasePage } from ${JSON.stringify(moduleUrl)};
                try {
                  inspectPublishReleasePage({
                    repo: 'openclaw/openclaw', tag: 'v2026.9.5', sourceSha: ${JSON.stringify(sha)},
                    runGh() {
                      if (${JSON.stringify(releaseState)} === 'absent') throw new Error('HTTP 404: Not Found');
                      return JSON.stringify({ draft: true, body: 'Draft notes' });
                    },
                  });
                  console.log(JSON.stringify({ admitted: true }));
                } catch (error) {
                  console.log(JSON.stringify({ admitted: false, message: error.message }));
                }
              `,
            ],
            { cwd: dir, env: createNestedGitEnv(), encoding: "utf8" },
          ),
        );
      expect(inspect()).toMatchObject({
        admitted: false,
        message: expect.stringContaining("release notes exceed GitHub's body limit"),
      });
    },
  );
});
