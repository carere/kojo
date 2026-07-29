import { Effect } from "effect";
import { HOST_INFORMATION, LEGACY_HOST_INFORMATION } from "../models/host-information";

export const getHostInformation = Effect.succeed(LEGACY_HOST_INFORMATION);
export const getHostCapabilities = Effect.succeed(HOST_INFORMATION);
