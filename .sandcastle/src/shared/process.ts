import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ExternalServiceError, ProcessError, WorkflowError } from "../types/errors";
import { failureMessage } from "./external-failure";

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export const quoteShellArgument = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export const outputTail = (value: string, maximum = 8_000) =>
  value.length > maximum ? value.slice(-maximum) : value;

export const runProcess = Effect.fn("runProcess")(function* (
  command: ReadonlyArray<string>,
  cwd?: string,
  inheritOutput = false,
) {
  const [executable, ...args] = command;
  if (!executable) {
    return yield* new WorkflowError({
      message: "Cannot run an empty command",
      operation: "process.run",
    });
  }

  const execute = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(executable, args, {
        cwd,
        stderr: inheritOutput ? "inherit" : "pipe",
        stdout: inheritOutput ? "inherit" : "pipe",
      });

      if (inheritOutput) {
        const exitCode = yield* handle.exitCode;
        return { exitCode, stderr: "", stdout: "" } satisfies ProcessResult;
      }

      const result = yield* Effect.all(
        {
          exitCode: handle.exitCode,
          stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
          stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
        },
        { concurrency: "unbounded" },
      );

      return result satisfies ProcessResult;
    }),
  );

  return yield* execute.pipe(
    Effect.mapError(
      (cause) =>
        new ExternalServiceError({
          cause,
          message: failureMessage(cause),
          operation: command.join(" "),
          service: "process",
        }),
    ),
  );
});

export const processFailure = (
  command: ReadonlyArray<string>,
  result: ProcessResult,
  cwd?: string,
) => {
  const detail = outputTail(
    result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
  );
  return new ProcessError({
    command,
    cwd: cwd ?? null,
    exitCode: result.exitCode,
    message: `${command.join(" ")} failed: ${detail}`,
    stderr: result.stderr,
    stdout: result.stdout,
  });
};

export const runRequired = Effect.fn("runRequired")(function* (
  command: ReadonlyArray<string>,
  cwd?: string,
  inheritOutput = false,
) {
  const result = yield* runProcess(command, cwd, inheritOutput);
  if (result.exitCode !== 0) {
    return yield* processFailure(command, result, cwd);
  }
  return result;
});

export const runText = Effect.fn("runText")(function* (
  command: ReadonlyArray<string>,
  cwd?: string,
) {
  const result = yield* runRequired(command, cwd);
  return result.stdout.trim();
});
