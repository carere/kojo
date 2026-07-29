import { evaluateProjectDefinition } from "./bun-project-definition-validation";

const send = process.send?.bind(process);
Object.defineProperty(process, "send", { configurable: true, value: undefined });
const path = process.argv[2];
if (path === undefined || send === undefined) process.exitCode = 1;
else send(await evaluateProjectDefinition(path));
