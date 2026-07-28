import { spawnSync, type ChildProcess } from "node:child_process";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Terminates the complete subprocess tree owned by an engine adapter.
 *
 * POSIX children are spawned as process-group leaders, so a negative PID
 * reaches the adapter and every agent process below it. Windows has no
 * equivalent signalable process group; taskkill /T /F is the supported tree
 * termination path there. The bounded wait prevents shutdown from hanging on
 * a child that ignores SIGTERM.
 */
export async function terminateProcessTree(child: ChildProcess, graceMs = 2_000): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  if (process.platform === "win32") {
    // /T includes descendants; /F is necessary for console processes that do
    // not participate in a shared console control group.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!exited) child.kill();
    await Promise.race([exit, delay(graceMs)]);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([exit, delay(graceMs)]);
  if (exited) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await Promise.race([exit, delay(1_000)]);
}
