import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluatePluginNpmBootstrapGate,
  evaluateReleasePublishGates,
} from "../../scripts/lib/release-publish-gates.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const targetSha = "a".repeat(40);
const manifest = {
  workflowName: "Full Release Validation",
  targetSha,
  releaseProfile: "stable",
  rerunGroup: "all",
  runReleaseSoak: "true",
  controls: { performanceBlocking: true },
  childRuns: { productPerformance: { conclusion: "success" } },
  validationInputs: { coveragePolicy: "full" },
};

describe("release publication control admission", () => {
  it.each([
    [
      "beta plugin on stable root",
      "2026.9.5-beta.1",
      "beta",
      "v2026.9.5",
      "latest",
      "beta",
      "",
      "PASS",
    ],
    [
      "stable plugin on matching stable root",
      "2026.9.5",
      "latest",
      "v2026.9.5",
      "latest",
      "stable",
      "",
      "PASS",
    ],
    [
      "stable plugin with waived beta validation",
      "2026.9.5",
      "latest",
      "v2026.9.5",
      "latest",
      "beta",
      "Approved",
      "PASS",
    ],
    ["alpha plugin", "2026.9.5-alpha.1", "alpha", "v2026.9.5-alpha.1", "alpha", "beta", "", "FAIL"],
    [
      "extended-stable plugin",
      "2026.8.33",
      "extended-stable",
      "v2026.8.33",
      "extended-stable",
      "full",
      "",
      "FAIL",
    ],
    [
      "stable plugin on beta root",
      "2026.9.5",
      "latest",
      "v2026.9.5-beta.1",
      "beta",
      "stable",
      "",
      "FAIL",
    ],
    [
      "stable plugin with another version",
      "2026.9.4",
      "latest",
      "v2026.9.5",
      "latest",
      "stable",
      "",
      "FAIL",
    ],
    [
      "stable plugin without waiver",
      "2026.9.5",
      "latest",
      "v2026.9.5",
      "latest",
      "beta",
      "",
      "FAIL",
    ],
  ])(
    "evaluates bootstrap for %s",
    (
      _name,
      packageVersion,
      publishTag,
      releaseTag,
      npmDistTag,
      releaseProfile,
      stableSoakWaiver,
      status,
    ) => {
      expect(
        evaluatePluginNpmBootstrapGate({
          packageName: "@openclaw/fixture",
          packageVersion,
          publishTag,
          releaseTag,
          npmDistTag,
          releaseProfile,
          stableSoakWaiver,
        }),
      ).toMatchObject({ id: "plugin-npm.bootstrap.@openclaw/fixture", status });
    },
  );

  it.each([
    { name: "stable evidence", overrides: {}, failures: [] },
    { name: "unsealed rerun", overrides: { rerunGroup: "performance" }, failures: ["rerun-group"] },
    { name: "missing soak", overrides: { runReleaseSoak: "false" }, failures: ["soak"] },
    {
      name: "advisory performance",
      overrides: { controls: { performanceBlocking: false } },
      failures: ["performance"],
    },
    {
      name: "waived advisory and soak",
      overrides: { controls: { performanceBlocking: false }, runReleaseSoak: "false" },
      waiver: "Approved after infrastructure failure",
      failures: [],
    },
    {
      name: "blank waiver",
      overrides: { runReleaseSoak: "false" },
      waiver: " \n\t",
      failures: ["soak"],
    },
    {
      name: "failed waived performance",
      overrides: {
        controls: { performanceBlocking: false },
        childRuns: { productPerformance: { conclusion: "failure" } },
      },
      waiver: "Approved",
      failures: ["performance"],
    },
  ])("evaluates every parent and core gate for $name", ({ overrides, waiver, failures }) => {
    for (const consumer of ["publisher", "core-npm"] as const) {
      const gates = evaluateReleasePublishGates({
        manifest: { ...manifest, ...overrides },
        consumer,
        releaseTag: "v2026.9.5",
        npmDistTag: "latest",
        stableSoakWaiver: waiver,
        expectedSha: targetSha,
      });
      expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual(
        failures.map((id) => `${consumer}.${id}`),
      );
    }
  });

  it("surfaces the core rejection hidden by beta-profile parent admission", () => {
    const input = {
      manifest: { ...manifest, releaseProfile: "beta", controls: { performanceBlocking: false } },
      releaseTag: "v2026.9.5",
      npmDistTag: "latest",
    };
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "publisher" }).some(
        (gate) => gate.status === "FAIL",
      ),
    ).toBe(false);
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "core-npm" }).filter(
        (gate) => gate.status === "FAIL",
      ),
    ).toMatchObject([{ id: "core-npm.performance" }]);
  });

  it.each([
    { controls: { performanceBlocking: "true" } },
    { runReleaseSoak: true },
    { childRuns: { productPerformance: { conclusion: "failure" } } },
  ])("retains stricter stable closeout controls: %j", (overrides) => {
    const input = {
      manifest: { ...manifest, ...overrides },
      releaseTag: "v2026.9.5",
      npmDistTag: "latest",
    };
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "publisher" }).some(
        (gate) => gate.status === "FAIL",
      ),
    ).toBe(false);
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "stable-closeout" }).some(
        (gate) => gate.status === "FAIL",
      ),
    ).toBe(true);
  });

  it("reports independent identity and policy failures together", () => {
    const gates = evaluateReleasePublishGates({
      manifest: {
        ...manifest,
        workflowName: "Other",
        targetSha: "b".repeat(40),
        rerunGroup: "performance",
        runReleaseSoak: "false",
      },
      consumer: "publisher",
      releaseTag: "v2026.9.5",
      npmDistTag: "latest",
      expectedSha: targetSha,
      expectedReleaseProfile: "full",
    });
    expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual([
      "publisher.workflow",
      "publisher.target",
      "publisher.profile",
      "publisher.rerun-group",
      "publisher.soak",
    ]);
  });

  it("runs without installed dependencies and preserves escaped workflow waiver outputs", () => {
    const root = tempRoots.make("release-publish-gates-");
    const manifestPath = join(root, "manifest.json");
    const output = join(root, "output");
    const summary = join(root, "summary");
    const waiver = 'Infrastructure 100% unavailable\nOperator "approved"';
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        runReleaseSoak: "false",
        controls: { performanceBlocking: false },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/lib/release-publish-gates.mts"),
        "--consumer",
        "publisher",
        "--manifest",
        manifestPath,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          RELEASE_TAG: "v2026.9.5",
          RELEASE_NPM_DIST_TAG: "latest",
          EXPECTED_SHA: targetSha,
          EXPECTED_RELEASE_PROFILE: "from-validation",
          STABLE_SOAK_WAIVER: waiver,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Infrastructure 100%25 unavailable%0AOperator "approved"');
    expect(readFileSync(output, "utf8").split("\n")).toEqual([
      `stable_soak_waiver=${JSON.stringify(waiver)}`,
      `stable_soak_waiver=${JSON.stringify(waiver)}`,
      "release_profile=stable",
      "coverage_policy=full",
      "",
    ]);
    expect(readFileSync(summary, "utf8")).toBe(`- Stable soak waived by operator: ${waiver}\n`);
  });
});
