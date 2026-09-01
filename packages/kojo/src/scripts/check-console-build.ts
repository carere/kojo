/**
 * Does the published package actually carry a Console?
 *
 * The Daemon serves `index.html` from the active managed release. A package with the front end
 * missing would install cleanly but could not open its Console.
 *
 * So `kojo:build` depends on `console:build` and then asserts three things about what landed:
 * the shell exists where the Daemon looks for it, it is a document rather than an empty file, and it
 * references a bundle. The third is what separates a real build from a shell prerendered against a
 * broken client build — the exact failure that would leave a blank page with no error anywhere.
 */

const consoleDirectory = new URL("../../console/", import.meta.url);
const shell = new URL("index.html", consoleDirectory);

const fail = (reason: string): never => {
  process.stderr.write(`the Console build is not usable: ${reason}\n`);
  process.exit(1);
};

const file = Bun.file(shell);
if (!(await file.exists())) {
  fail(`no index.html under ${consoleDirectory.pathname} — run \`moon run console:build\``);
}

const html = await file.text();
if (!html.includes("<html")) {
  fail(`${shell.pathname} is not an HTML document`);
}
if (!/<script[^>]+src=/.test(html)) {
  fail(`${shell.pathname} references no client bundle, so the page would never start`);
}

process.stdout.write(`the Console shell is in place: ${shell.pathname}\n`);
