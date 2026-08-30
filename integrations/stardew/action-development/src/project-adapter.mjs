import { ACTION_REGISTRY } from "./action-registry.mjs";
import { createProjectAdapter } from "./project-adapter-core.mjs";

const productionAdapter = createProjectAdapter(ACTION_REGISTRY);

export const runActionProject = productionAdapter.runActionProject;
export const verifyActionProjectReport = productionAdapter.verifyActionProjectReport;
