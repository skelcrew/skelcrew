// The commands that open the screen: plain sc and sc --list, which open the lead, and the
// screen's parts beside it: the sidebar, the footer and the details.
import { usage } from "./input.ts";

export async function leadCommand(list: boolean, from?: string): Promise<void> {
  const { attachToLead } = await import("../attach.ts");
  const { openDb } = await import("../db.ts");
  const { bringInFrom, approveCheckout, checkRepository, checkoutTop, repositories } = await import(
    "../flow/repo.ts"
  );
  const { originHere } = await import("../machine/origin.ts");
  const { ensureDaemon } = await import("../machine/service.ts");
  const { prepareMachine, signInForAgents } = await import("../machine/setup.ts");
  prepareMachine();
  await checkRepository(from);
  await ensureDaemon();
  const origin = originHere();
  if (from === undefined && origin === null && checkoutTop() !== null) {
    const { toRun } = await import("../format.ts");
    const steps = toRun(["git remote add origin <url>", "git push -u origin HEAD"]);
    console.log(`This git repository has no remote. To add a remote and push it:\n${steps}`);
    console.log("Then run sc again.");
    process.exit(1);
  }
  const found = await bringInFrom(from);
  if (from === undefined) approveCheckout();
  signInForAgents(found);
  const { tellOldKeys } = await import("../config.ts");
  tellOldKeys(undefined);
  if (repositories(openDb()).length === 0) return;
  const away = from === undefined && origin === null;
  if (await attachToLead("skelcrew", list, found, away)) return;
  console.error("No git repository found. Run sc inside a git repository to open it.");
  process.exit(1);
}

export async function screenCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { runSidebar } = await import("../screen/sidebar.ts");
  const { runFooter } = await import("../screen/footer.ts");
  if (command === "footer" && rest.length === 2) {
    const [agents, session] = rest;
    if (agents && session) {
      await runFooter(agents, session);
      return;
    }
  }
  if (command === "sidebar" && rest.length === 5) {
    const [agents, session, where, repository, onHost] = rest;
    if (agents && session && where !== undefined && repository && onHost !== undefined) {
      await runSidebar(agents, session, where, repository, onHost);
      return;
    }
  }
  if (command === "details" && rest.length === 3) {
    const [, repository, name] = rest;
    if (repository && name) {
      const { runTaskDetails } = await import("../screen/task.ts");
      await runTaskDetails(repository, name);
      return;
    }
  }
  usage(command);
}
