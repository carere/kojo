export interface ProcessRow {
  readonly pid: number;
  readonly parent: number;
  readonly command: string;
}

export const findProcessAncestor = (
  processes: ReadonlyArray<ProcessRow>,
  startingProcessId: number,
  matches: (process: ProcessRow) => boolean,
): ProcessRow | undefined => {
  const processesById = new Map(processes.map((process) => [process.pid, process]));
  const visited = new Set<number>();
  let processId = startingProcessId;
  while (processId > 0 && !visited.has(processId)) {
    visited.add(processId);
    const process = processesById.get(processId);
    if (process === undefined) return undefined;
    if (matches(process)) return process;
    processId = process.parent;
  }
  return undefined;
};
