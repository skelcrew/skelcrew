// The commands that open the screen: plain sc and sc --list, which open the lead, and the
// screen's parts beside it: the sidebar, the footer and the details.
import { errorText, toRun } from "../format.ts";
import { usage } from "./input.ts";

export async function leadCommand(list: boolean, from?: string): Promise<void> {
  const { attachToLead } = await import("../attach.ts");
  const { mayHaveRepositories, openDb } = await import("../db.ts");
  const {
    bringInFrom,
    approveCheckout,
    checkRepository,
    checkoutTop,
    noRepositories,
    repositories,
    stopsWithSteps,
  } = await import("../flow/repo.ts");
  const stopWithSteps = (error: unknown): never => {
    if (!stopsWithSteps(error)) throw error;
    console.log(errorText(error));
    process.exit(1);
  };
  const { originHere } = await import("../machine/origin.ts");
  const { ensureDaemon, loginPath } = await import("../machine/service.ts");
  const { prepareMachine, signInForAgents } = await import("../machine/setup.ts");
  process.env.PATH = loginPath();
  if (from === undefined && Bun.which("git") && checkoutTop() === null && !mayHaveRepositories()) {
    console.log(noRepositories);
    return;
  }
  prepareMachine();
  const origin = originHere();
  const away = from === undefined && origin === null;
  const details = await checkRepository(from).catch(stopWithSteps);
  await ensureDaemon();
  if (away && checkoutTop() !== null) {
    const steps = toRun(["git remote add origin <url>", "git push -u origin HEAD"]);
    console.log(`This git repository has no remote. To add a remote and push it:\n${steps}`);
    console.log("Then run sc again.");
    process.exit(1);
  }
  const found = await bringInFrom(from, details).catch(stopWithSteps);
  if (from === undefined) approveCheckout();
  signInForAgents(found);
  const { tellOldKeys } = await import("../config.ts");
  tellOldKeys(undefined);
  if (repositories(openDb()).length === 0) return;
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
  if (command === "details" && (rest.length === 3 || rest.length === 4)) {
    const [, repository, name, confirm] = rest;
    if (repository && name) {
      const { runTaskDetails } = await import("../screen/task.ts");
      await runTaskDetails(repository, name, confirm);
      return;
    }
  }
  usage(command);
}
