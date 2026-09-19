import { execFileSync } from "node:child_process";
import { inspectLinuxUpdaterManifest } from "../linux-updater-manifest.mjs";
import {
  loadReleaseNotesForTag,
  renderGithubReleaseNotes,
  verifyGithubReleaseNotes,
} from "../render-github-release-notes.mts";
import { isRecord, trimString } from "./record-shared.mjs";
import { loadReleaseChangelog } from "./release-changelog.mjs";
import {
  evaluateReleasePublishGates,
  evaluateStableRollbackDrill,
  type ReleasePublishGate,
} from "./release-publish-gates.mts";
import {
  preflightApi,
  requirePreflightRecord,
  type PublishPreflightGh,
} from "./release-publish-preflight-evidence.mts";
import { resolveReleaseTagPackageIdentity } from "./release-version.mjs";
import { verifyStablePublishRecovery } from "./stable-publish-recovery.mjs";
import {
  requiresLinuxUpdaterObservation,
  verifyReleaseEvidenceChecksum,
  verifyStableMainCloseout,
} from "./stable-release-closeout.mjs";

export function inspectPublishReleasePage(input: {
  repo: string;
  tag: string;
  sourceSha: string;
  runGh: PublishPreflightGh;
}) {
  const notes = loadReleaseNotesForTag({
    rootDir: process.cwd(),
    ref: input.sourceSha,
    tag: input.tag,
  });
  const notesTarget = {
    changelog: notes.section,
    version: notes.version,
    tag: input.tag,
    repository: input.repo,
    contributionRecordPath: notes.recordPath ?? undefined,
  };
  renderGithubReleaseNotes(notesTarget);
  let release: Record<string, unknown>;
  try {
    release = requirePreflightRecord(
      preflightApi(input.runGh, input.repo, `releases/tags/${encodeURIComponent(input.tag)}`),
      "release",
    );
  } catch (error) {
    if (error instanceof Error && /\b404\b/u.test(error.message)) {
      return undefined;
    }
    throw error;
  }
  const body = release.body;
  if (typeof body !== "string") {
    throw new Error("Existing release body is missing.");
  }
  if (body.includes("<!-- openclaw-release-publication:docs-v1 -->")) {
    throw new Error(
      "The release already belongs to the docs-publication owner; the initial publisher must not overwrite it.",
    );
  }
  if (release.draft !== true) {
    const canonical = verifyGithubReleaseNotes({ body, ...notesTarget });
    const assets = Array.isArray(release.assets) ? release.assets.filter(isRecord) : [];
    const hasAsset = assets.some(
      (asset) => asset.name === `openclaw-${input.tag.slice(1)}-dependency-evidence.zip`,
    );
    const hasProof = body.includes("### Release verification");
    if (!canonical.matches || !hasAsset || (hasProof && !body.includes(input.sourceSha))) {
      throw new Error(
        "Public release has incomplete or noncanonical postpublish evidence for this exact source. Reconcile that release before retrying the initial publisher.",
      );
    }
  }
  return release;
}

type CloseoutPreflightInput = {
  repo: string;
  tag: string;
  sourceSha: string;
  attempt: string;
  runId: string;
  runGh: PublishPreflightGh;
};

function readExistingCloseoutReceipt(input: CloseoutPreflightInput) {
  const api = (endpoint: string) => preflightApi(input.runGh, input.repo, endpoint);
  const releaseFor = (tag: string) =>
    requirePreflightRecord(api(`releases/tags/${encodeURIComponent(tag)}`), "release");
  let release: Record<string, unknown>;
  try {
    release = releaseFor(input.tag);
  } catch (error) {
    if (error instanceof Error && /\b404\b/u.test(error.message)) {
      return undefined;
    }
    throw error;
  }
  const readAsset = (owner: Record<string, unknown>, name: string): Buffer | undefined => {
    const assets = Array.isArray(owner.assets)
      ? owner.assets.filter(isRecord).filter((asset) => asset.name === name)
      : [];
    if (!assets.length) {
      return undefined;
    }
    const asset = assets[0]!;
    if (
      assets.length !== 1 ||
      typeof asset.id !== "number" ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1
    ) {
      throw new Error(`Release asset ${name} is not uniquely identified.`);
    }
    return Buffer.from(
      input.runGh([
        "api",
        `repos/${input.repo}/releases/assets/${asset.id}`,
        "--method",
        "GET",
        "-H",
        "Accept:application/octet-stream",
      ]),
    );
  };
  const name = `openclaw-${input.tag.slice(1)}-stable-main-closeout.json`;
  const bytes = readAsset(release, name);
  const checksum = readAsset(release, `${name}.sha256`);
  if (!bytes) {
    if (checksum) {
      throw new Error("Stable closeout checksum exists without its manifest; repair is refused.");
    }
    return undefined;
  }
  if (checksum) {
    verifyReleaseEvidenceChecksum({
      assetName: name,
      assetBytes: bytes,
      checksum: checksum.toString("utf8"),
    });
  }
  const manifest = requirePreflightRecord(
    JSON.parse(bytes.toString("utf8")),
    "existing closeout manifest",
  );
  if (typeof manifest.mainSha !== "string" || !/^[a-f0-9]{40}$/u.test(manifest.mainSha)) {
    throw new Error("Existing closeout manifest has no exact main snapshot.");
  }
  const packageJson = requirePreflightRecord(
    JSON.parse(
      execFileSync("git", ["show", `${input.sourceSha}:package.json`], {
        encoding: "utf8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      }),
    ),
    "release package",
  );
  if (typeof packageJson.version !== "string") {
    throw new Error("Release package version is missing.");
  }
  const identity = resolveReleaseTagPackageIdentity(input.tag, packageJson.version);
  const evidenceTag = identity.baseTag ?? input.tag;
  const evidenceRelease = evidenceTag === input.tag ? release : releaseFor(evidenceTag);
  const fullName = `openclaw-${evidenceTag.slice(1)}-release-manifest.json`;
  const fullBytes = readAsset(evidenceRelease, fullName);
  const fullChecksum = readAsset(evidenceRelease, `${fullName}.sha256`);
  if (!fullBytes || !fullChecksum) {
    throw new Error("Existing closeout requires checksummed Full Release Validation evidence.");
  }
  verifyReleaseEvidenceChecksum({
    assetName: fullName,
    assetBytes: fullBytes,
    checksum: fullChecksum.toString("utf8"),
  });
  const fullManifest = requirePreflightRecord(
    JSON.parse(fullBytes.toString("utf8")),
    "attached validation manifest",
  );
  if (
    fullManifest.workflowName !== "Full Release Validation" ||
    fullManifest.runId !== input.runId ||
    fullManifest.runAttempt !== input.attempt ||
    fullManifest.targetSha !== input.sourceSha
  ) {
    throw new Error("Attached validation manifest does not match the closeout tuple.");
  }
  const postpublishName = `openclaw-${evidenceTag.slice(1)}-postpublish-evidence.json`;
  const postpublishBytes = readAsset(evidenceRelease, postpublishName);
  const postpublishChecksum = readAsset(evidenceRelease, `${postpublishName}.sha256`);
  if (!postpublishBytes || !postpublishChecksum) {
    throw new Error("Existing closeout requires checksummed immutable postpublish evidence.");
  }
  verifyReleaseEvidenceChecksum({
    assetName: postpublishName,
    assetBytes: postpublishBytes,
    checksum: postpublishChecksum.toString("utf8"),
  });
  const evidence = requirePreflightRecord(
    JSON.parse(postpublishBytes.toString("utf8")),
    "postpublish evidence",
  );
  const stableSoakWaiver = evidence.stableSoakWaiver ?? "";
  if (typeof stableSoakWaiver !== "string") {
    throw new Error("Postpublish evidence has an invalid stable soak waiver.");
  }
  const controlErrors = evaluateReleasePublishGates({
    manifest: fullManifest,
    consumer: "stable-closeout",
    releaseTag: input.tag,
    npmDistTag: "latest",
    stableSoakWaiver,
  }).filter((gate) => gate.status === "FAIL");
  if (controlErrors.length) {
    throw new Error(controlErrors.map((gate) => gate.message).join(" "));
  }
  const validations = Array.isArray(evidence.workflowRuns)
    ? evidence.workflowRuns
        .filter(isRecord)
        .filter((run) => run.label === "Full Release Validation")
    : [];
  if (
    evidence.releaseTag !== evidenceTag ||
    validations.length !== 1 ||
    validations[0]!.id !== input.runId ||
    (validations[0]!.runAttempt != null && validations[0]!.runAttempt !== input.attempt) ||
    typeof evidence.releasePublishRunId !== "string" ||
    !/^[1-9][0-9]*$/u.test(evidence.releasePublishRunId)
  ) {
    throw new Error(
      "Existing closeout postpublish evidence does not bind the selected release and validation tuple.",
    );
  }
  const drill = requirePreflightRecord(manifest.rollbackDrill, "recorded rollback drill");
  return {
    manifest,
    fullManifest,
    evidence,
    release,
    mainSha: manifest.mainSha,
    publisherRunId: evidence.releasePublishRunId,
    drillId: trimString(drill.id),
    drillDate: trimString(drill.date),
    checksummed: Boolean(checksum),
  };
}

export async function inspectStableCloseoutPreflight(
  input: CloseoutPreflightInput,
): Promise<ReleasePublishGate[]> {
  const rows: ReleasePublishGate[] = [];
  const api = (endpoint: string) => preflightApi(input.runGh, input.repo, endpoint);
  const add = (
    id: string,
    status: ReleasePublishGate["status"],
    message: string,
    remediation = "",
  ) => rows.push({ id: `stable-closeout.${id}`, status, message, remediation });
  let drillId = "",
    drillDate = "";
  let existing: ReturnType<typeof readExistingCloseoutReceipt>;
  try {
    existing = readExistingCloseoutReceipt(input);
  } catch (error) {
    add(
      "existing-receipt",
      "FAIL",
      error instanceof Error ? error.message : String(error),
      "Reconcile the existing immutable closeout evidence before replay; do not replace a conflicting receipt.",
    );
  }
  try {
    drillId =
      existing?.drillId ??
      trimString(
        requirePreflightRecord(
          api("actions/variables/RELEASE_ROLLBACK_DRILL_ID"),
          "rollback drill id",
        ).value ?? "",
      );
    drillDate =
      existing?.drillDate ??
      trimString(
        requirePreflightRecord(
          api("actions/variables/RELEASE_ROLLBACK_DRILL_DATE"),
          "rollback drill date",
        ).value ?? "",
      );
    rows.push(
      ...evaluateStableRollbackDrill({
        rollbackDrillId: drillId,
        rollbackDrillDate: drillDate,
        nowMs: Date.now(),
        allowStaleRollbackDrill: Boolean(existing),
      }),
    );
  } catch (error) {
    add(
      "rollback-variables",
      "FAIL",
      error instanceof Error ? error.message : String(error),
      "Record RELEASE_ROLLBACK_DRILL_ID and RELEASE_ROLLBACK_DRILL_DATE after the approved rollback drill, or use closeout's explicit manual override.",
    );
  }
  try {
    const currentMainSha = String(
      requirePreflightRecord(
        requirePreflightRecord(api("git/ref/heads/main"), "main").object,
        "main commit",
      ).sha,
    );
    if (!/^[a-f0-9]{40}$/u.test(currentMainSha)) {
      throw new Error("Invalid main SHA.");
    }
    const mainSha = existing?.mainSha ?? currentMainSha;
    const git = (ref: string, file: string) =>
      execFileSync("git", ["show", `${ref}:${file}`], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      });
    const tagPackageJson = requirePreflightRecord(
      JSON.parse(git(input.sourceSha, "package.json")),
      "release package",
    );
    const mainPackageJson = requirePreflightRecord(
      JSON.parse(git(mainSha, "package.json")),
      "main package",
    );
    const version = String(tagPackageJson.version);
    const mainRelease = loadReleaseChangelog({ rootDir: process.cwd(), ref: mainSha, version });
    const tagRelease = loadReleaseChangelog({
      rootDir: process.cwd(),
      ref: input.sourceSha,
      version,
    });
    let release: Record<string, unknown> = {};
    try {
      release = requirePreflightRecord(
        api(`releases/tags/${encodeURIComponent(input.tag)}`),
        "release",
      );
    } catch (error) {
      if (!(error instanceof Error && /\b404\b/u.test(error.message))) {
        throw error;
      }
    }
    const recordedRecovery = existing?.manifest.releasePublishRecovery;
    const publishRecovery =
      existing && isRecord(recordedRecovery) && recordedRecovery.mode === "split-publication-v1"
        ? await verifyStablePublishRecovery({
            evidence: existing.evidence,
            manifest: existing.fullManifest,
            sourceSha: input.sourceSha,
            tag: input.tag,
          })
        : undefined;
    const result = verifyStableMainCloseout({
      tag: input.tag,
      mainPackageJson,
      tagPackageJson,
      mainRelease,
      tagRelease,
      mainAppcast: git(mainSha, "appcast.xml"),
      publishedAppcast: existing ? git(currentMainSha, "appcast.xml") : undefined,
      release: {
        ...release,
        tagName: release.tag_name,
        isDraft: release.draft,
        isPrerelease: release.prerelease,
      },
      releaseTagSha: input.sourceSha,
      mainSha,
      fullReleaseValidationRunId: input.runId,
      fullReleaseValidationRunAttempt: input.attempt,
      releasePublishRunId: existing?.publisherRunId ?? "",
      rollbackDrillId: drillId,
      rollbackDrillDate: drillDate,
      nowMs: Date.now(),
      allowStaleRollbackDrill: Boolean(existing),
      existingManifest: existing?.manifest,
      publishRecovery,
      allowFailedPublishRecovery: Boolean(publishRecovery),
      linuxUpdaterObservation:
        existing &&
        requiresLinuxUpdaterObservation({
          release: { ...release, tagName: release.tag_name },
          existingManifest: existing.manifest,
        })
          ? inspectLinuxUpdaterManifest({ repository: input.repo, carrierTag: input.tag })
          : undefined,
    });
    if (existing) {
      add(
        "existing-receipt",
        result.errors.length ? "FAIL" : existing.checksummed ? "PASS" : "WARN",
        result.errors.join(" ") ||
          (existing.checksummed
            ? "Existing checksummed closeout receipt matches its source, publication tuple and immutable assets."
            : "Existing closeout receipt is valid but its checksum upload is incomplete."),
        result.errors.length
          ? "Reconcile the recorded closeout through its canonical owner; preserve existing immutable receipt bytes."
          : existing.checksummed
            ? ""
            : "Replay Stable Main Closeout to attach the missing checksum without replacing the receipt.",
      );
    }
    const sourceErrors = result.errors.filter((reason: string) =>
      /^(?:main (?:package\.json|CHANGELOG\.md|changelog)|release tag package\.json)/u.test(reason),
    );
    // Main absorbs the shipped version/changelog after publication. Readiness
    // is advisory here; making it a publish prerequisite would deadlock the release.
    add(
      "main-source",
      sourceErrors.length ? "WARN" : "PASS",
      sourceErrors.join(" ") ||
        `Main ${mainSha} has compatible version and exact shipped changelog accounting.`,
      sourceErrors.length
        ? "Reconcile the shipped version and changelog onto main before stable closeout; preserve the frozen contribution record."
        : "",
    );
    for (const error of result.errors.filter(
      (reason: string) => !sourceErrors.includes(reason) && !reason.startsWith("rollback drill"),
    )) {
      add(
        "release-assets",
        "WARN",
        error,
        "Complete publication and run the canonical Stable Main Closeout owner to verify the actual release assets, appcast and Linux selectors.",
      );
    }
  } catch (error) {
    add(
      existing ? "existing-receipt" : "main-source",
      existing ? "FAIL" : "WARN",
      error instanceof Error ? error.message : String(error),
      "Make the exact current main and release commits available with git fetch --no-tags origin main; reconcile the release version/changelog before closeout.",
    );
  }
  for (const [id, message, remediation] of [
    [
      "publish-receipt",
      "The future Release Publish parent/attempt and successful core/Docker jobs cannot be proved before dispatch.",
      "Closeout requires the exact successful publisher, or its supported failed-parent recovery with successful npm and Docker jobs.",
    ],
    [
      "immutable-receipt",
      "Any existing checksummed closeout manifest and later release assets need final readback after publication.",
      "The closeout owner verifies the manifest checksum, immutable asset inventory, allowed late assets, appcast, and exact Linux updater selectors.",
    ],
  ]) {
    if (existing && id === "immutable-receipt") {
      continue;
    }
    add(id!, "WARN", message!, remediation!);
  }
  return rows;
}
