import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { VERSION } from "../version.js";
import { extractErrorCode, formatErrorMessage } from "./errors.js";
import {
  readRestartSentinelSnapshot,
  writeRestartSentinelIfUnchanged,
} from "./restart-sentinel.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "./restart.js";
import type { UpdateCampaignController } from "./update-campaign.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel.js";
import type { TrackedDevUpdateTarget } from "./update-dev-target.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import { recordUpdateRunRecoveryDiagnostics } from "./update-run-diagnostics.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { AUTO_UPDATE_STEP_TIMEOUT_MS } from "./update-run-timeouts.js";
import type { UpdateRunResult } from "./update-runner.js";
import type { AutoUpdateRunParams, AutoUpdateRunResult } from "./update-startup-auto-run.js";

export type AutoUpdateRunner = (params: AutoUpdateRunParams) => Promise<AutoUpdateRunResult>;

// The owner joins preflight and handoff readiness, never the detached helper's
// subsequent wait for Gateway exit.
export async function runCampaignUpdate(params: {
  channel: "stable" | "beta" | "dev";
  mode: UpdateRunResult["mode"];
  version: string;
  tag: string;
  forced: boolean;
  root?: string;
  devTarget?: TrackedDevUpdateTarget;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  runAuto: AutoUpdateRunner;
  canApply: () => boolean;
  campaign: UpdateCampaignController;
  onAttempt: (version: string) => void;
  onUpdateRunCreated?: () => void;
  signal?: AbortSignal;
}): Promise<"handoff" | "applied" | "failed"> {
  const campaignId = params.campaign.getState()?.id;
  const isCurrent = () =>
    campaignId !== undefined &&
    !params.signal?.aborted &&
    params.campaign.getState()?.id === campaignId;
  // The countdown may outlive its config. After this admission, the applying
  // owner retains its target until handoff or stop/drain settles it.
  if (!isCurrent() || !params.canApply()) {
    return "failed";
  }
  const run = createUpdateRun({
    trigger: "campaign",
    origin: { campaignId },
    target: {
      channel: params.channel,
      tag: params.tag,
      kind: params.mode === "git" ? "git" : "package",
      ...(params.mode === "unknown"
        ? {}
        : { installationMethod: params.mode === "git" ? "git-checkout" : `${params.mode}-global` }),
      ...(params.mode === "git" ? { sha: params.version } : { version: params.version }),
    },
    before: { version: VERSION },
  });
  const runId = run.runId;
  params.onUpdateRunCreated?.();
  const { channel, forced, tag, version } = params;
  const attempt = { channel, forced, tag, version };
  let terminal: Parameters<typeof finishUpdateRun>[1] | undefined = {
    status: "failed",
    reason: "unexpected-error",
  };
  try {
    // Capture recovery code before the updater can replace the running installation.
    const { runUpdateFailureTriage } = await import("./update-triage.js");
    const { sentinel, revision } = await readRestartSentinelSnapshot();
    if (!isCurrent()) {
      return "failed";
    }
    params.onAttempt(params.version);

    const outcome = await params.runAuto({
      runId,
      channel: params.channel,
      mode: params.mode,
      timeoutMs: AUTO_UPDATE_STEP_TIMEOUT_MS,
      restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
      ...(params.root ? { root: params.root } : {}),
      ...(params.channel === "dev" ? {} : { packageTargetVersion: params.version }),
      ...(params.devTarget ? { devTarget: params.devTarget } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (outcome.status === "handoff") {
      terminal = undefined;
      recordUpdateRunStep(runId, {
        step: "managed-service update handoff",
        status: "completed",
        endedAtMs: Date.now(),
      });
      if (!isCurrent()) {
        return "failed";
      }
      params.log.info("auto-update handoff started", {
        ...attempt,
        ...(outcome.command ? { command: outcome.command } : {}),
        ...(outcome.logPath ? { logPath: outcome.logPath } : {}),
      });
      return "handoff";
    }
    terminal = {
      status: outcome.result.status === "skipped" ? "skipped" : "failed",
      reason: outcome.result.reason,
      after: outcome.result.after,
    };
    recordUpdateRunRecoveryDiagnostics(
      runId,
      (recordedVerification) => ({
        ...(outcome.result.recovery
          ? { recovery: recordedVerification.recovery ?? outcome.result.recovery }
          : {}),
        ...(outcome.result.rollbackOutcome
          ? {
              rollbackOutcome:
                recordedVerification.rollbackOutcome ?? outcome.result.rollbackOutcome,
            }
          : {}),
      }),
      (message) => params.log.info(message),
    );
    recordUpdateRunPhase(runId, "requested", {
      before: outcome.result.before,
      origin: { nextAction: outcome.message },
    });
    for (const step of outcome.result.steps.flatMap(updateRunStepsFromResultStep)) {
      recordUpdateRunStep(runId, { ...step, endedAtMs: Date.now() });
    }
    if (!isCurrent()) {
      return "failed";
    }
    let triageHint: string | undefined;
    if (classifyUpdateOutcome(outcome.result) === "failed") {
      const triage = await runUpdateFailureTriage({
        failure: { result: outcome.result, error: outcome.message },
        target: { root: params.root, env: process.env },
        mode: "json",
        runtime: {
          log: (message) => params.log.info(message),
          error: (message) => params.log.info(message),
        },
        signal: params.signal,
        isCurrent,
      });
      if (triage.status !== "cancelled") {
        triageHint = triage.hint;
        recordUpdateRunPhase(runId, "requested", { origin: { doctorHint: triageHint } });
      }
    }
    if (!isCurrent()) {
      return "failed";
    }
    // Publish before campaign-ended observers refresh status. A concurrent restart
    // or update keeps its notification; this attempt may replace only its snapshot.
    if (!sentinel || !isPendingControlPlaneUpdateRestartSentinel(sentinel.payload)) {
      await writeRestartSentinelIfUnchanged({
        payload: {
          ...buildUpdateRestartSentinelPayload({
            result: outcome.result,
            meta: { runId, root: params.root, note: outcome.message },
          }),
          ...(triageHint ? { doctorHint: triageHint } : {}),
        },
        expectedRevision: revision,
        isCurrent,
      });
    }
    const skipped = classifyUpdateOutcome(outcome.result) === "noop";
    params.log.info(skipped ? "auto-update attempt skipped" : "auto-update attempt failed", {
      ...attempt,
      reason: outcome.result.reason,
      message: outcome.message,
      ...(triageHint ? { triage: triageHint } : {}),
    });
    if (skipped) {
      finishUpdateRun(runId, terminal);
      terminal = undefined;
      params.campaign.clear();
    }
    return skipped ? "applied" : "failed";
  } catch (error) {
    const detail = formatErrorMessage(error);
    params.log.info(`auto-update attempt failed error=${detail}`, attempt);
    // A handed-off run belongs to the successor; only finish campaign-owned work.
    if (terminal) {
      terminal.status = "failed";
      terminal.reason = extractErrorCode(error) || "unexpected-error";
      let current = run;
      try {
        current = getUpdateRun(runId) ?? run;
      } catch {
        params.log.info(
          "Update history could not be read; preserving the original automatic update failure with captured admission facts.",
        );
      }
      const step =
        current.steps.findLast((entry) => entry.status === "in_progress")?.step ?? current.phase;
      const fact = createUpdateErrorFact(step, error);
      recordUpdateRunStep(runId, {
        step,
        status: "failed",
        detail: fact.message,
        failureFacts: [fact],
      });
      recordUpdateRunRecoveryDiagnostics(
        runId,
        (recordedVerification) => ({
          rollbackOutcome: recordedVerification.rollbackOutcome ?? {
            status: "not-attempted",
            reason: "The startup campaign does not roll back a failed automatic update handoff",
          },
        }),
        (message) => params.log.info(message),
      );
    }
    throw error;
  } finally {
    if (terminal) {
      finishUpdateRun(runId, terminal);
    }
  }
}
