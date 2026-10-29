import { StressPlanSchema, WorkflowSchema, type ContractProject } from "@apicc/core";
import { semanticProject, semanticIds } from "../runtime-semantics.mjs";

/** One synthetic project for the actual Linux agent, desktop host, and final renderer. */
export function acceptanceStress(origin: string, path = "stress-case", workflow = false, iterations = 4) {
  const project: ContractProject = semanticProject(origin, false);
  project.name = "F7c T8 synthetic acceptance";
  project.variables.path = path;
  project.stressPolicy = { trustedOrigins: [origin] };
  const api = project.collections[0]!.apis[0]!;
  api.cases[0]!.assertions = [{ id: "status", target: "status", op: "eq", expected: "200" }];
  const held = structuredClone(api); held.contract.id = "10000000-0000-4000-8000-000000000099";
  held.contract.metadata.name = "Held request for controlled IPC disconnect"; held.contract.request.path = "/hold-packaged-disconnect";
  project.collections[0]!.apis.push(held);
  const noopId = "10000000-0000-4000-8000-000000000090";
  project.workflows = [WorkflowSchema.parse({ id: noopId, name: "Recover failed HTTP request", status: "enabled", executionVersion: 2, nodes: [{ id: "recovered", kind: "noop" }], edges: [] }),
    WorkflowSchema.parse({ id: semanticIds.workflow!, name: "HTTP failure recovered logically", status: "enabled", executionVersion: 2,
      nodes: [{ id: "request", kind: "request", apiId: semanticIds.api!, caseId: "synthetic-case", policy: { onError: { workflowId: noopId, mode: "recover" } } }], edges: [] })];
  const roles = ["setup", "vuSetup", "vuTeardown", "teardown"] as const;
  const lifecycle = Object.fromEntries(roles.map((role, index) => {
    const workflowId = `10000000-0000-4000-8000-${String(91 + index).padStart(12, "0")}`;
    const leaf = structuredClone(api); leaf.contract.id = `10000000-0000-4000-8000-${String(81 + index).padStart(12, "0")}`;
    leaf.contract.metadata.name = role;
    leaf.contract.request.path = `/lifecycle-${role}`;
    project.collections[0]!.apis.push(leaf);
    project.workflows.push(WorkflowSchema.parse({ id: workflowId, name: role, status: "enabled", executionVersion: 2, nodes: [{ id: role, kind: "request", apiId: leaf.contract.id, caseId: "synthetic-case" }], edges: [] }));
    return [role, { workflowId }];
  }));
  const plan = StressPlanSchema.parse({ formatVersion: 1,
    target: workflow ? { kind: "workflow", workflowId: semanticIds.workflow } : { kind: "case", collectionId: semanticIds.collection, apiId: semanticIds.api, caseId: "synthetic-case" },
    environmentId: semanticIds.environment, load: { kind: "constant-vus", vus: workflow ? 2 : 1 }, maxVus: workflow ? 2 : 1,
    maxRequestConcurrency: 2, maxRps: 8, gracefulStopMs: 500, termination: { maxIterations: iterations }, ...(workflow ? { lifecycle } : {}) });
  project.stressPlans = [{ formatVersion: 1, id: workflow ? "t8-workflow" : "t8-case", name: workflow ? "Lifecycle and recovered HTTP failure" : "Four bounded case requests", updatedAt: 0, plan }];
  const heldPlan = StressPlanSchema.parse({ ...plan, target: { kind: "case", collectionId: semanticIds.collection, apiId: held.contract.id, caseId: "synthetic-case" }, lifecycle: undefined, load: { kind: "constant-vus", vus: 2 }, maxVus: 2 });
  return { project, target: { kind: "stress" as const, plan }, heldTarget: { kind: "stress" as const, plan: heldPlan } };
}
