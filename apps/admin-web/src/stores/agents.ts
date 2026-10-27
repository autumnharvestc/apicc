import { reactive } from "vue";
import { z } from "zod";
import { AdminApiError, type AdminClient } from "../api/client.js";
import { createAgentsApi, formValidationIssues, type FormValidationIssue, type AgentSummary, type AgentDetail, type ProjectExecutionAgents, type ProjectSettings, type WorkspacePolicy, type ScriptGrant, type AgentPatch, type PolicyPatch, type ProjectUpdate } from "../api/agents.js";
import type { AdminTreeProject } from "../api/contract.js";

export function createAgentsStore({ client }: { client: AdminClient }) {
  const api = createAgentsApi(client);
  let epoch=0, actionSeq=0, listSeq=0, directorySeq=0, allocationSeq=0;
  let nodeSeq = 0, projectSeq = 0, workspaceSeq = 0, grantSeq = 0;
  const state = reactive({
    nodes: [] as AgentSummary[], node: null as AgentDetail | null,
    directory: [] as { id: string; name: string }[], workspaceIds: [] as string[],
    available: [] as AgentSummary[], allocation: [] as string[], allocationAgentId:"", projects: [] as AdminTreeProject[],
    workspaceId:"",allocationWorkspaceId:"",allocationStatus:"idle" as "idle"|"loading"|"ready"|"failed",
    workspace: null as WorkspacePolicy | null,
    project: null as ProjectExecutionAgents | null, candidates: [] as AgentSummary[], settings: null as ProjectSettings | null,
    grant: null as ScriptGrant | null,
    enrollment: null as { enrollmentToken: string; expiresAt: string } | null,
    error: "", validationIssues:[] as FormValidationIssue[], conflict: false, busy: false, loading: false,
  });
  function fail(error: unknown) {
    state.conflict = error instanceof AdminApiError && error.status === 409;
    state.validationIssues=error instanceof z.ZodError?formValidationIssues(error):[];
    state.error = error instanceof z.ZodError?"":error instanceof Error ? error.message : String(error);
  }
  function invalidateAction(){actionSeq++;state.busy=false;}
  async function action(work: (current:()=>boolean) => Promise<void>, scope:()=>boolean=()=>true) {
    if (state.busy || state.conflict) return false;
    const session=epoch,ticket=++actionSeq;
    const current=()=>session===epoch&&ticket===actionSeq&&scope();
    state.busy = true; state.error = "";state.validationIssues=[];
    try { await work(current); return current(); } catch (error) { if(current())fail(error); return false; } finally { if(session===epoch&&ticket===actionSeq)state.busy=false; }
  }
  const store = Object.assign(state, {
    reset() {
      epoch++;invalidateAction();nodeSeq++; projectSeq++; workspaceSeq++; grantSeq++;listSeq++;directorySeq++;allocationSeq++;
      state.nodes=[]; state.node=null; state.directory=[]; state.workspaceIds=[]; state.available=[]; state.allocation=[]; state.allocationAgentId=""; state.projects=[];
      state.workspaceId="";state.allocationWorkspaceId="";state.allocationStatus="idle";state.validationIssues=[];
      state.workspace=null; state.project=null; state.candidates=[]; state.settings=null; state.grant=null; state.enrollment=null;
      state.error=""; state.conflict=false; state.busy=false; state.loading=false;
    },
    async refreshNodes() {
      const session=epoch,seq=++listSeq;const current=()=>session===epoch&&seq===listSeq;
      state.loading=true;
      try {const nodes=await api.list();if(current()){state.nodes=nodes;state.error="";}} catch (error) {if(current())fail(error);} finally {if(current())state.loading=false;}
    },
    async loadDirectory() {const session=epoch,seq=++directorySeq;try {const result=await api.directory();if(session===epoch&&seq===directorySeq)state.directory=result;} catch(error) {if(session===epoch&&seq===directorySeq)fail(error);} },
    async createNode(name: string) { return action(async current=>{ const node=await api.create(name);if(!current())return;await store.refreshNodes();if(current())await store.selectNode(node.id,true); }); },
    async selectNode(id: string, preserveAction=false) {
      if(!preserveAction)invalidateAction();const session=epoch,seq=++nodeSeq; state.enrollment=null; state.node=null; state.workspaceIds=[]; state.conflict=false; state.error="";state.validationIssues=[];
      try { const [node, grants]=await Promise.all([api.get(id),api.grants(id)]); if(session===epoch&&seq===nodeSeq){state.node=node;state.workspaceIds=grants.workspaceIds;} }
      catch(error) {if(session===epoch&&seq===nodeSeq)fail(error);}
    },
    async saveNode(id: string, config: AgentPatch, extra: { name?: string; acceptingJobs?: boolean; expectedPolicyVersion?: string; policy?: {maxQueuedJobs: number} } = {}) {
      const current=state.node;if(!current||current.id!==id)return false;
      const seq=nodeSeq;return action(async valid=>{const result=await api.save(id,current.configVersion,config,extra);if(valid()){state.node=result;state.nodes=state.nodes.map(n=>n.id===id?result:n);} },()=>seq===nodeSeq&&state.node?.id===id);
    },
    async saveGrants(id: string, ids: string[]) {const seq=nodeSeq;return action(async current=>{await api.saveGrants(id,ids);if(current())state.workspaceIds=[...ids];},()=>seq===nodeSeq&&state.node?.id===id);},
    async issueEnrollment(id: string) {const seq=nodeSeq;return action(async current=>{const result=await api.enrollment(id);if(current())state.enrollment=result;},()=>seq===nodeSeq&&state.node?.id===id);},
    async revoke(id: string) {return action(async current=>{await api.revoke(id);if(!current())return;await store.refreshNodes();if(current())await store.selectNode(id,true);},()=>state.node?.id===id);},
    async loadWorkspace(ws: string) {
      invalidateAction();const session=epoch,seq=++workspaceSeq;allocationSeq++;state.available=[];state.workspace=null;state.projects=[];state.allocation=[];state.allocationAgentId="";state.conflict=false;state.error="";
      state.workspaceId=ws;state.allocationWorkspaceId="";state.allocationStatus="idle";state.validationIssues=[];
      try {const [available,policy,tree]=await Promise.all([api.available(ws),api.workspace(ws),client.getTree(ws)]);if(session===epoch&&seq===workspaceSeq){state.available=available;state.workspace=policy;state.projects=tree.projects;}}
      catch(error){if(session===epoch&&seq===workspaceSeq)fail(error);}
    },
    async loadAllocation(ws: string, agentId: string) {
      const session=epoch,wsSeq=workspaceSeq,seq=++allocationSeq;state.allocation=[];state.allocationAgentId=agentId;state.allocationWorkspaceId=ws;state.allocationStatus="loading";state.error="";
      try{const result=await api.allocations(ws,agentId);if(session===epoch&&wsSeq===workspaceSeq&&seq===allocationSeq&&state.workspaceId===ws){state.allocation=result.projectIds;state.allocationStatus="ready";}}catch(error){if(session===epoch&&wsSeq===workspaceSeq&&seq===allocationSeq){state.allocationStatus="failed";fail(error);}}
    },
    async allocate(ws: string, agentId: string, ids: string[]) {
      if(state.allocationStatus!=="ready"||state.workspaceId!==ws||state.allocationWorkspaceId!==ws||state.allocationAgentId!==agentId)return false;
      const seq=workspaceSeq,allocation=allocationSeq;return action(async current=>{await api.allocate(ws,agentId,ids);if(current())state.allocation=[...ids];},()=>seq===workspaceSeq&&allocation===allocationSeq);
    },
    async saveWorkspace(ws: string, policy: PolicyPatch) {
      const version=state.workspace?.configVersion;if(version===undefined)return false;
      const seq=workspaceSeq;return action(async current=>{const result=await api.saveWorkspace(ws,version,policy);if(current())state.workspace=result;},()=>seq===workspaceSeq);
    },
    async loadProject(ws: string, projectId: string) {
      invalidateAction();const session=epoch,seq=++projectSeq;grantSeq++;state.project=null;state.settings=null;state.candidates=[];state.grant=null;state.conflict=false;state.error="";state.loading=true;
      state.validationIssues=[];
      try {
        const [project,settings]=await Promise.all([api.project(ws,projectId),api.settings(ws,projectId)]);
        if(session!==epoch||seq!==projectSeq)return;
        const candidates=project.canManageScripts?await api.candidates(ws,projectId):[];
        if(session===epoch&&seq===projectSeq){state.project=project;state.settings=settings;state.candidates=candidates;}
      }catch(error){if(session===epoch&&seq===projectSeq)fail(error);}finally{if(session===epoch&&seq===projectSeq)state.loading=false;}
    },
    async saveProject(ws: string, projectId: string, value: ProjectUpdate) {
      const version=state.settings?.configVersion;if(version===undefined)return false;
      const seq=projectSeq;
      return action(async current=>{const result=await api.saveProject(ws,projectId,version,value);if(!current())return;const project=await api.project(ws,projectId);if(current()){state.settings=result;state.project=project;}},()=>seq===projectSeq);
    },
    async loadGrant(ws: string, projectId: string, agentId: string) {
      const session=epoch,seq=++grantSeq;state.grant=null;
      try{const result=await api.scriptGrant(ws,projectId,agentId);if(session===epoch&&seq===grantSeq)state.grant=result;}catch(error){if(session===epoch&&seq===grantSeq)fail(error);}
    },
    async saveGrant(ws: string, projectId: string, agentId: string, scope: "script-version" | "project", scripts: ScriptGrant["scripts"], riskConfirmed: boolean) {
      const grant=state.grant;if(!grant||grant.agentId!==agentId)return false;const seq=projectSeq, currentGrantSeq=grantSeq;
      return action(async current=>{const result=await api.saveScriptGrant(ws,projectId,{agentId,expectedVersion:grant.version,scope,scripts,riskConfirmed});if(!current())return;const project=await api.project(ws,projectId);if(current()){state.project=project;state.grant=result;}},()=>seq===projectSeq&&currentGrantSeq===grantSeq);
    },
  });
  return store;
}
export type AgentsStore = ReturnType<typeof createAgentsStore>;
