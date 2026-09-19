import { createUpdateErrorFact } from "./update-failure-facts.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { getUpdateRun, recordUpdateRunVerification } from "./update-run-ledger.js";
import type { UpdateRunRecord } from "./update-run-record.js";

type RecoveryDiagnostics = Pick<UpdateRunRecord["verification"], "recovery" | "rollbackOutcome">;

/** Recovery summaries cannot interrupt lifecycle work or replace its original outcome. */
export function recordUpdateRunRecoveryDiagnostics(
  runId: string,
  diagnostics:
    | RecoveryDiagnostics
    | ((recorded: Readonly<RecoveryDiagnostics>) => RecoveryDiagnostics),
  warn: (message: string) => void,
  options: UpdateRunLedgerOptions = {},
): void {
  try {
    const facts =
      typeof diagnostics === "function"
        ? diagnostics(getUpdateRun(runId, options)?.verification ?? {})
        : diagnostics;
    if (facts.recovery || facts.rollbackOutcome) {
      recordUpdateRunVerification(runId, facts, options);
    }
  } catch (error) {
    const fact = createUpdateErrorFact("requested", error, options.env);
    warn(
      `Update recovery diagnostics could not be recorded (${fact.code}): ${fact.message ?? "no error message"}`,
    );
  }
}
