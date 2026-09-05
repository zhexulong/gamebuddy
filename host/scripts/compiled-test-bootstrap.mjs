import { bindWindowsStaleLockReclaimer } from "../dist-test/path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../dist-test/windows-stale-lock-reclaimer/index.js";

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
