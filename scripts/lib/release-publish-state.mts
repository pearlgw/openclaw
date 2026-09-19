import { execFileSync } from "node:child_process";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";
import { validateNpmPublishBoundary } from "../openclaw-npm-extended-stable-release.mjs";
import { resolveOpenClawNpmResumeRun } from "../openclaw-npm-resume-run.mts";
import corePackagePolicy from "./npm-core-release-packages.json" with { type: "json" };
import {
  fetchNpmRegistryPackumentWithRetry,
  resolveNpmPublishPlan,
  resolvePublishedNpmVersionRoute,
} from "./npm-publish-plan.mjs";
import {
  collectPluginReleaseVersionFloorErrors,
  parsePluginReleaseSelection,
  resolveSelectedPublishablePluginPackages,
} from "./plugin-npm-release.ts";
import {
  collectPublishablePluginPackagesFromCandidates,
  type PluginPackageJson,
  type PublishablePluginPackage,
} from "./plugin-publication-collector.ts";
import { isRecord } from "./record-shared.mjs";
import type { ReleasePublishGate } from "./release-publish-gates.mts";
import { collectReleaseVersionFloorErrors } from "./release-version.mjs";

export function readReleasePublicationPackages(input: {
  rootDir: string;
  sourceSha: string;
  npmDistTag: string;
  pluginPublishScope: "selected" | "all-publishable";
  plugins?: string;
}) {
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha)) {
    throw new Error("Package inventory requires an exact lowercase 40-character source SHA.");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: input.rootDir,
      encoding: "utf8",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  try {
    git(["cat-file", "-e", `${input.sourceSha}^{commit}`]);
  } catch {
    throw new Error(
      `Release source ${input.sourceSha} is not available locally. Run git fetch --no-tags origin ${input.sourceSha}, then repeat preflight.`,
    );
  }
  const paths = new Set(
    git([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      input.sourceSha,
      "--",
      "extensions",
      "packages",
    ]).split("\0"),
  );
  const read = (path: string) => git(["show", `${input.sourceSha}:${path}`]);
  const root: unknown = JSON.parse(read("package.json"));
  if (!isRecord(root) || typeof root.version !== "string") {
    throw new Error("Release source package.json is missing its version.");
  }
  const version = root.version;
  const dependencies = isRecord(root.dependencies) ? root.dependencies : {};
  const corePackages = corePackagePolicy.flatMap((policy) => {
    const path = `${policy.path}/package.json`;
    const requiredDependency =
      policy.dependency && typeof dependencies[policy.dependency] === "string";
    if (!paths.has(path)) {
      if (requiredDependency) {
        throw new Error(`Publishable core package manifest is missing: ${path}`);
      }
      return [];
    }
    const manifest = JSON.parse(read(path)) as PluginPackageJson;
    if (
      policy.dependency ? !requiredDependency : manifest.openclaw?.release?.publishToNpm !== true
    ) {
      return [];
    }
    if (manifest.name !== policy.name || manifest.version !== version) {
      throw new Error(`${path} must publish ${policy.name}@${version}.`);
    }
    return [{ packageName: policy.name, version }];
  });
  const candidates = [...paths]
    .filter((path) => /^extensions\/[^/]+\/package\.json$/u.test(path))
    .map((path) => {
      const packageDir = path.slice(0, -"/package.json".length);
      return {
        extensionId: packageDir.slice("extensions/".length),
        packageDir,
        packageJson: JSON.parse(read(path)) as PluginPackageJson,
        readmeText: paths.has(`${packageDir}/README.md`)
          ? read(`${packageDir}/README.md`)
          : undefined,
      };
    });
  const selection = parsePluginReleaseSelection(input.plugins);
  if (input.pluginPublishScope === "selected" && selection.length === 0) {
    throw new Error("plugin_publish_scope=selected requires a nonempty plugins selection.");
  }
  const select = (target: "npm" | "clawhub") => {
    const plugins = collectPublishablePluginPackagesFromCandidates(candidates, target, {
      ...(input.pluginPublishScope === "selected" ? { packageNames: selection } : {}),
      ...(target === "npm" && input.npmDistTag === "extended-stable"
        ? { npmDistTag: "extended-stable", rootVersion: version }
        : {}),
    });
    return input.pluginPublishScope === "selected"
      ? resolveSelectedPublishablePluginPackages({ plugins, selection })
      : plugins;
  };
  return { version, corePackages, npmPlugins: select("npm"), clawhubPlugins: select("clawhub") };
}

export async function observeReleaseNpmState(input: {
  version: string;
  npmDistTag: string;
  plugins: readonly PublishablePluginPackage[];
  corePackages?: readonly { packageName: string; version: string }[];
  publishOpenclawNpm?: boolean;
}) {
  const gates: ReleasePublishGate[] = [];
  const corePackages = input.publishOpenclawNpm === false ? [] : (input.corePackages ?? []);
  const coreNames = new Set(["openclaw", ...corePackages.map((pkg) => pkg.packageName)]);
  const floorErrors = [
    ...(input.publishOpenclawNpm === false ? [] : collectReleaseVersionFloorErrors(input.version)),
    ...collectPluginReleaseVersionFloorErrors(input.plugins),
    ...collectPluginReleaseVersionFloorErrors(corePackages),
  ];
  gates.push({
    id: "npm.version-floors",
    status: floorErrors.length ? "FAIL" : "PASS",
    message: floorErrors.length
      ? floorErrors.join(" ")
      : "Selected packages satisfy release version floors.",
    remediation: floorErrors.length
      ? "Select a release candidate whose package versions satisfy the canonical release floors."
      : "",
  });
  const packages = [
    ...(input.publishOpenclawNpm === false
      ? []
      : [{ packageName: "openclaw", version: input.version }]),
    ...corePackages,
    ...input.plugins,
  ];
  const observed = await runTasksWithConcurrency({
    limit: 8,
    tasks: packages.map((pkg) => async () => {
      const id = `npm.package.${pkg.packageName}`;
      try {
        const registry = await fetchNpmRegistryPackumentWithRetry({
          packageName: pkg.packageName,
          packageUrl: `https://registry.npmjs.org/${encodeURIComponent(pkg.packageName)}`,
          maxBytes: 16 * 1024 * 1024,
          timeoutMs: 15_000,
          attempts: 2,
          redirect: "manual",
        });
        if (
          registry.status !== 404 &&
          (!registry.ok || !isRecord(registry.packument) || !isRecord(registry.packument.versions))
        ) {
          throw new Error(`npm returned HTTP ${registry.status} or an invalid package inventory.`);
        }
        const packument = isRecord(registry.packument) ? registry.packument : {};
        const versions = isRecord(packument.versions) ? packument.versions : {};
        const published = Object.hasOwn(versions, pkg.version);
        const bootstrap = registry.status === 404;
        const core = coreNames.has(pkg.packageName);
        const tags = isRecord(packument["dist-tags"]) ? packument["dist-tags"] : {};
        const plan = resolveNpmPublishPlan(
          pkg.version,
          typeof tags.beta === "string" ? tags.beta : undefined,
          input.npmDistTag === "extended-stable" ? input.npmDistTag : undefined,
        );
        if (core) {
          validateNpmPublishBoundary(pkg.version, input.npmDistTag);
          if (input.npmDistTag === "beta") {
            plan.publishTag = "beta";
            plan.mirrorDistTags = [];
          }
        }
        if (!bootstrap && Object.keys(versions).length === 0) {
          throw new Error(
            "The package exists with empty version history; missing-package bootstrap cannot be inferred.",
          );
        }
        if (bootstrap && core) {
          throw new Error(
            "Core publication requires an existing package configured for trusted publishing; plugin token-bootstrap approval does not apply.",
          );
        }
        const route =
          published && pkg.packageName === "openclaw"
            ? resolvePublishedNpmVersionRoute({
                packageVersion: pkg.version,
                publishPlan: plan,
                distTags: tags,
              })
            : undefined;
        const gate: ReleasePublishGate = {
          id,
          status: bootstrap || published ? "WARN" : "PASS",
          message: `${pkg.packageName}@${pkg.version}: ${bootstrap ? "not visible in npm; possible token bootstrap" : published ? `already published${route ? ` (${route})` : `; ${core ? "core subpackage" : "plugin"} publication skips this version`}` : `not published; ${plan.publishTag} publication planned`}.`,
          remediation: bootstrap
            ? "If a recent run may have published this package, reconcile its registry readback first. Otherwise verify bootstrap approval eligibility and run the documented read-only whoami probe against the workflow's NPM_TOKEN before dispatch."
            : published && pkg.packageName === "openclaw"
              ? "Supply openclaw_npm_resume_run_id for the verified original successful publisher; resume rechecks immutable tarball identity."
              : published
                ? "Retain the exact selection; published package versions are reused."
                : "",
        };
        return { gate, pkg, bootstrap, published, known: true, publishTag: plan.publishTag };
      } catch (error) {
        return {
          gate: {
            id,
            status: "FAIL",
            message: `${pkg.packageName}@${pkg.version}: ${error instanceof Error ? error.message : String(error)}`,
            remediation:
              "Resolve the registry or canonical publication-route error and repeat preflight before dispatch.",
          } satisfies ReleasePublishGate,
          pkg,
          bootstrap: false,
          published: false,
          known: false,
          publishTag: undefined,
        };
      }
    }),
  });
  if (observed.hasError) {
    throw observed.firstError;
  }
  gates.push(...observed.results.map((result) => result.gate));
  return {
    gates,
    bootstrapCandidates: observed.results.flatMap((result) =>
      result.bootstrap && result.publishTag
        ? [{ ...result.pkg, publishTag: result.publishTag }]
        : [],
    ),
    publishedPackages: observed.results
      .filter((result) => result.published)
      .map((result) => result.pkg),
    unknownPackages: observed.results.filter((result) => !result.known).map((result) => result.pkg),
    corePublished: observed.results.some(
      (result) => result.pkg.packageName === "openclaw" && result.published,
    ),
  };
}

type GitHubRelease = {
  id: number;
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  html_url: string;
  target_commitish: string;
};
type Run = {
  id: number;
  run_attempt: number;
  status: string;
  event: string;
  display_title: string;
  html_url: string;
};

export function observeReleaseGitHubState(input: {
  repository: string;
  releaseTag: string;
  sourceSha: string;
  npmDistTag: string;
  runGh?: (args: string[]) => string;
}) {
  const gates: ReleasePublishGate[] = [];
  const runGh =
    input.runGh ??
    ((args: string[]) =>
      execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      }));
  const cache = new Map<string, string>();
  const raw = (endpoint: string) => {
    const cached = cache.get(endpoint);
    if (cached !== undefined) {
      return cached;
    }
    const value = runGh([
      "api",
      `repos/${input.repository}/${endpoint}`,
      "--method",
      "GET",
      ...(endpoint.endsWith("/logs") ? ["--allow-escape-sequences"] : []),
    ]);
    cache.set(endpoint, value);
    return value;
  };
  const api = (endpoint: string): unknown => JSON.parse(raw(endpoint));
  let release: GitHubRelease | undefined;
  try {
    const value = api(`releases/tags/${encodeURIComponent(input.releaseTag)}`);
    if (
      !isRecord(value) ||
      typeof value.id !== "number" ||
      typeof value.draft !== "boolean" ||
      typeof value.prerelease !== "boolean" ||
      typeof value.html_url !== "string" ||
      typeof value.target_commitish !== "string" ||
      value.tag_name !== input.releaseTag
    ) {
      throw new Error("Invalid GitHub release response.");
    }
    release = value as GitHubRelease;
    gates.push({
      id: "github.release",
      status: "WARN",
      message: `${release.draft ? "Draft" : "Published"} GitHub release already exists: ${release.html_url}`,
      remediation: "Resume the existing release and preserve its assets and publication evidence.",
    });
  } catch (error) {
    const absent = error instanceof Error && /\b404\b/u.test(error.message);
    gates.push({
      id: "github.release",
      status: absent ? "PASS" : "WARN",
      message: absent
        ? "No GitHub release exists for the tag."
        : "GitHub release state could not be read.",
      remediation: absent
        ? ""
        : `gh api repos/${input.repository}/releases/tags/${encodeURIComponent(input.releaseTag)} --method GET`,
    });
  }
  for (const workflow of [
    "openclaw-release-publish.yml",
    "plugin-npm-release.yml",
    "plugin-clawhub-release.yml",
    "plugin-clawhub-new.yml",
  ]) {
    const runs = new Map<number, Run>();
    let complete = true;
    for (const status of [
      "in_progress",
      "queued",
      "waiting",
      "pending",
      "requested",
      "action_required",
    ]) {
      const endpoint = `actions/workflows/${workflow}/runs?status=${status}&per_page=100`;
      try {
        const response = api(endpoint);
        if (
          !isRecord(response) ||
          !Array.isArray(response.workflow_runs) ||
          typeof response.total_count !== "number"
        ) {
          throw new Error("Invalid run inventory.");
        }
        for (const run of response.workflow_runs) {
          if (
            !isRecord(run) ||
            typeof run.id !== "number" ||
            typeof run.run_attempt !== "number" ||
            typeof run.status !== "string" ||
            typeof run.event !== "string" ||
            typeof run.display_title !== "string" ||
            typeof run.html_url !== "string"
          ) {
            throw new Error("Invalid workflow run record.");
          }
          runs.set(run.id, run as Run);
        }
        if (response.total_count > 100) {
          complete = false;
        }
      } catch {
        complete = false;
      }
    }
    if (!complete) {
      gates.push({
        id: `concurrency.${workflow}.inventory`,
        status: "WARN",
        message:
          "Active-run inventory is unavailable or exceeds the bounded first page; concurrency is unresolved.",
        remediation: `gh api 'repos/${input.repository}/actions/workflows/${workflow}/runs?status=waiting&per_page=100' --method GET`,
      });
    }
    let candidates = 0;
    for (const run of runs.values()) {
      if (run.event !== "workflow_dispatch") {
        continue;
      }
      const parent = workflow === "openclaw-release-publish.yml";
      const npm = workflow === "plugin-npm-release.yml";
      const titleSha = npm
        ? /^Plugin NPM (?:Release|Artifact Preflight|Trusted Publisher Preflight) \[(?:default|extended-stable)\] ([a-f0-9]{40})$/u.exec(
            run.display_title,
          )?.[1]
        : undefined;
      if (titleSha && titleSha !== input.sourceSha) {
        continue;
      }
      let match = titleSha === input.sourceSha;
      let evidence = match ? "exact workflow run title" : "dispatch inputs unavailable";
      let parentRunId: string | undefined;
      if (!match && candidates++ < 10) {
        try {
          const jobs = api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
          const job =
            isRecord(jobs) && Array.isArray(jobs.jobs)
              ? jobs.jobs.find(
                  (entry) =>
                    isRecord(entry) && entry.status === "completed" && typeof entry.id === "number",
                )
              : undefined;
          if (isRecord(job) && typeof job.id === "number") {
            const log = raw(`actions/jobs/${job.id}/logs`);
            const env = (key: string) => {
              const values = [
                ...log.matchAll(new RegExp(`^\\S+ +${key}: ([^\\r\\n]*)$`, "gmu")),
              ].map((value) => value[1]);
              return values.length && new Set(values).size === 1 ? values[0] : undefined;
            };
            const value = env(parent ? "RELEASE_NPM_DIST_TAG" : "TARGET_REF");
            const dryRun = env("DRY_RUN");
            if (value !== undefined && value !== (parent ? input.npmDistTag : input.sourceSha)) {
              continue;
            }
            if (!parent && !npm && dryRun === "true") {
              continue;
            }
            match =
              value === (parent ? input.npmDistTag : input.sourceSha) &&
              (parent || npm || dryRun === "false");
            evidence = match
              ? `exact job ${job.id} dispatch environment`
              : "dispatch inputs incomplete in available job log";
            parentRunId = env("RELEASE_PUBLISH_RUN_ID");
          }
        } catch {
          evidence = "dispatch inputs unavailable from completed job logs";
        }
      }
      let orphan = "";
      if (match && parentRunId && /^[1-9][0-9]*$/u.test(parentRunId)) {
        try {
          const producer = api(`actions/runs/${parentRunId}`);
          if (isRecord(producer) && producer.status === "completed") {
            orphan = ` Parent ${parentRunId} is terminal (${String(producer.conclusion)}); this may be a detached child or orphan.`;
          }
        } catch {
          /* An unavailable parent cannot establish an orphan. */
        }
      }
      gates.push({
        id: `concurrency.${workflow}.${run.id}`,
        status: match ? "FAIL" : "WARN",
        message: `${run.status} run ${run.id}: ${match ? "same concurrency group" : "possible concurrency blocker"} (${evidence}).${orphan} ${run.html_url}`,
        remediation: match
          ? `Inspect and reconcile run ${run.id} before dispatch; do not cancel without checking parent ownership. gh api repos/${input.repository}/actions/runs/${run.id} --method GET`
          : `Resolve the run's exact ${parent ? "npm_dist_tag" : "ref and dry_run"} inputs before dispatch: gh api 'repos/${input.repository}/actions/runs/${run.id}/jobs?per_page=100' --method GET`,
      });
    }
    if (complete && !gates.some((gate) => gate.id.startsWith(`concurrency.${workflow}.`))) {
      gates.push({
        id: `concurrency.${workflow}.clear`,
        status: "PASS",
        message: "No matching active dispatch runs found in the current concurrency inventory.",
        remediation: "",
      });
    }
  }
  return { gates, release };
}

export function resolveReleaseNpmResumeRun(input: {
  repo: string;
  tag: string;
  workflowRef: string;
  runId?: string;
  runGh: (args: string[]) => string;
}): string {
  const api = (endpoint: string): unknown =>
    JSON.parse(input.runGh(["api", `repos/${input.repo}/${endpoint}`, "--method", "GET"]));
  let candidates: string[];
  if (input.runId) {
    candidates = [input.runId];
  } else {
    const result = api(
      `actions/workflows/openclaw-npm-release.yml/runs?branch=${encodeURIComponent(input.workflowRef)}&status=success&event=workflow_dispatch&per_page=100`,
    );
    if (!isRecord(result) || !Array.isArray(result.workflow_runs)) {
      throw new Error("Unable to list npm resume candidates.");
    }
    candidates = result.workflow_runs
      .filter(isRecord)
      .slice(0, 10)
      .map((candidate) => String(candidate.id));
  }
  for (const id of candidates) {
    if (!/^[1-9][0-9]*$/u.test(id)) {
      throw new Error("OpenClaw npm resume run id must be a positive integer.");
    }
    const result = api(`actions/runs/${id}/jobs?per_page=100`);
    if (
      !isRecord(result) ||
      !Array.isArray(result.jobs) ||
      result.jobs.length !== result.total_count ||
      !result.jobs.every(isRecord)
    ) {
      throw new Error("Incomplete npm publication job inventory.");
    }
    const approval = result.jobs.find(
      (job) => job.name === "validate_publish_request" && job.conclusion === "success",
    );
    if (
      !approval ||
      typeof approval.id !== "number" ||
      !result.jobs.some(
        (job) => job.name === "publish_openclaw_npm" && job.conclusion === "success",
      )
    ) {
      if (input.runId) {
        throw new Error(
          `Resume run ${id} lacks successful validate_publish_request and publish_openclaw_npm jobs.`,
        );
      }
      continue;
    }
    const log = input.runGh([
      "api",
      `repos/${input.repo}/actions/jobs/${approval.id}/logs`,
      "--method",
      "GET",
      "--allow-escape-sequences",
    ]);
    const tags = [...log.matchAll(/^\S+ +RELEASE_TAG: ([^\r\n]*)$/gmu)].map((match) => match[1]);
    // A successful run on the same tooling ref may publish another release.
    // Explicit IDs need the same source evidence as discovered candidates.
    if (!tags.length || tags.some((tag) => tag !== input.tag)) {
      if (input.runId) {
        throw new Error(`Resume run ${id} does not record the exact RELEASE_TAG ${input.tag}.`);
      }
      continue;
    }
    resolveOpenClawNpmResumeRun({
      repo: input.repo,
      runId: id,
      trustedWorkflowFullRef: `refs/tags/${input.workflowRef}`,
      trustedWorkflowRef: input.workflowRef,
      // Reuse the complete jobs response already checked above. The existing
      // authority owner still validates it, without another transport lookup.
      runGh: (args) =>
        args[0] === "run" && args[1] === "view" && args[2] === id
          ? JSON.stringify(result.jobs)
          : input.runGh(args),
    });
    return id;
  }
  throw new Error(
    "Core is already published, but no exact original publication run was found. Supply --openclaw-npm-resume-run-id.",
  );
}
