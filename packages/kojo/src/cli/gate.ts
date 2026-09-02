import {
  gate as gateCommand,
  makeGateCommand as makeCommand,
  askingLine as presentAskingLine,
  visibleAskings as selectVisibleAskings,
  validateGateAnswerFlags as validateAnswerFlags,
  gateWaitExit as waitExit,
} from "../contexts/gate/adapters/GateCommand.ts";

export const visibleAskings = selectVisibleAskings;
export const askingLine = presentAskingLine;
export const validateGateAnswerFlags = validateAnswerFlags;
export const gateWaitExit = waitExit;
export const makeGateCommand = makeCommand;
export const gate = gateCommand;
