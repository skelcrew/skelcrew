import { versionControlContract } from "../version-control.contract";
import { Git } from "./git";

versionControlContract("git", (repo) => new Git(repo.dir, repo.main));
