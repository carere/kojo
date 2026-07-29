import { Effect } from "effect";
import { HOST_INFORMATION } from "../models/host-information";

export const getHostInformation = Effect.succeed(HOST_INFORMATION);
