export const runGit = async (cwd: string, ...arguments_: ReadonlyArray<string>) => {
  const process = Bun.spawn(["git", ...arguments_], { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${arguments_.join(" ")} failed: ${stderr || stdout}`);
  return stdout.trim();
};
