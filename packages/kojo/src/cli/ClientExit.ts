import { Console, Effect, Runtime, Schema } from "effect";

export class ClientExit extends Schema.TaggedError<ClientExit>()("ClientExit", {
  message: Schema.String,
  code: Schema.Finite,
}) {
  readonly [Runtime.errorReported] = false;
  get [Runtime.errorExitCode](): number {
    return this.code;
  }
}

export const clientExit = (code: 1 | 2 | 3 | 4 | 130, message: string) =>
  Effect.andThen(Console.error(`kojo: ${message}`), Effect.fail(new ClientExit({ code, message })));
