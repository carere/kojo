import {
  type Finding,
  faults,
  isReady,
  type Standing,
} from "../contexts/scaffold/models/Finding.ts";

/** How wide a remedy is allowed to get before it is folded. Eighty is a terminal; this is prose. */
const width = 96;

const label: Record<Standing, string> = {
  ok: "ok",
  // Upper case, and the only upper case in the report. A person scanning twelve lines for the two
  // that matter should not have to read them.
  failed: "FAILED",
  skipped: "skipped",
};

const pad = (value: string, to: number) => value.padEnd(to);

/**
 * A paragraph folded to fit, with every line after the first indented under the first.
 *
 * A remedy says what to do, which takes a sentence rather than a phrase, and a sentence that runs
 * off the right of a terminal is a sentence nobody reads to the end of.
 */
export const fold = (text: string, indent: number, room: number): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  let current = "";

  for (const word of text.split(/\s+/).filter((piece) => piece !== "")) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= room) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);

  return lines.map((line, at) => (at === 0 ? line : `${" ".repeat(indent)}${line}`));
};

/** The last line: whether this factory can be called ready, and how many checks said otherwise. */
export const verdictLine = (findings: ReadonlyArray<Finding>): string => {
  const failing = faults(findings).length;
  return isReady(findings)
    ? `this factory is ready — ${findings.length} checks, none failed`
    : `this factory is not ready — ${failing} of ${findings.length} check${
        findings.length === 1 ? "" : "s"
      } failed`;
};

/**
 * The whole diagnosis, as a person reads it.
 *
 * One line per check whatever the standing, including the skips. A report that printed only the
 * failures would be shorter and would answer a different question: *what is wrong* rather than
 * *what was looked at*, and the second is the one that tells somebody a check they were counting on
 * never ran.
 *
 * The remedy is printed under its own failure rather than gathered at the bottom, so the sentence
 * that says what to do is beside the sentence that says what is wrong.
 */
export const renderDiagnosis = (options: {
  readonly root: string;
  readonly findings: ReadonlyArray<Finding>;
}): string => {
  const standing = Math.max(...Object.values(label).map((word) => word.length));
  const subject = Math.max(7, ...options.findings.map((finding) => finding.subject.length));
  const indent = standing + 2 + subject + 2;

  const rows = options.findings.flatMap((finding) => {
    const head = `${pad(label[finding.standing], standing)}  ${pad(finding.subject, subject)}  `;
    const lines = [`${head}${fold(finding.detail, indent, width - indent).join("\n")}`];
    if (finding.remedy !== undefined) {
      lines.push(
        `${" ".repeat(indent - 2)}→ ${fold(finding.remedy, indent, width - indent).join("\n")}`,
      );
    }
    return lines;
  });

  // No verdict line here. It is printed by the command, on stderr when it is bad, because the same
  // sentence is what the process fails with — and one sentence said twice is a report nobody trusts
  // to be saying two different things.
  return [`kojo doctor — ${options.root}`, "", ...rows, ""].join("\n");
};
