import { describe, expect, it } from "vitest";
import type { DebugInvocation, DebugResult } from "@apicc/core";
import { ContractWorkspaceSchema, DebugHistoryRecordSchema } from "@apicc/core/schema";
import { workspaceFixture } from "../../../../packages/core/tests/helpers/contractFixtures.js";
import { debugHistory } from "../../../../packages/core/tests/collaboration/fixtures.js";
import { FullOnlineJobSchema, type OnlineProjectView } from "../../src/shared/online/execution.js";
import { jobRecordFacts } from "../../src/renderer/src/execution/recordFacts.js";

const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
const collection = project.collections[0]!, asset = collection.apis[0]!;
const scope = {workspaceId:"11", groupId:"22", projectId:"33"};
const owner = {workspaceId:scope.workspaceId,groupId:scope.groupId,projectId:project.id};
const locator = {...owner,collectionId:collection.id,folderIds:["outer","inner"],apiId:asset.contract.id};
const testCase = {...locator,caseId:"shared-case",scope:"original-scope"};
const draftId = "00000000-0000-4000-8000-000000000099";
const request = {request:asset.contract.request,parameters:{},fields:[]};
const replay = {parameters:{},fields:[],available:false};
const history = DebugHistoryRecordSchema.options[1].parse(debugHistory()).result;

function facts(invocation: DebugInvocation, result?: DebugResult, view?: OnlineProjectView) {
  const job = FullOnlineJobSchema.parse({jobId:"78",executionId:"79",agentId:"5",state:"ended",cancelState:"none",executionReleased:true,reportState:"archived",
    task:{protocolVersion:1,jobId:"78",executionId:"79",scope,submittedByUserId:"7",contractProjectId:project.id,snapshotId:"66",manifestHash:"a".repeat(64),
      target:{kind:"debug",invocation},policyVersion:"1",requiredCoreBuildId:"b".repeat(64),scriptPlanDigest:"c".repeat(64),executionProfile:"no-script",
      runtimeCompatibilityId:"recorded",dispatchKind:"shared-debug",requiredCapabilities:["protocol:http","task:debug"]}});
  return jobRecordFacts(job,view ?? null,result && {executionId:"79",verdict:"failed",output:{kind:"debug",result}});
}

const base = {...history,source:{sourceKind:"asset" as const,locator,sourceApiRevision:"original"},
  run:{...history.run,envName:"Historical environment"},
  outcomes:[{...history.outcomes[0]!,apiId:locator.apiId,apiName:"Historical API",caseId:testCase.caseId,caseName:"Historical case"}]};
const caseResult: DebugResult = {...base,mode:"case",replay:{...replay,mode:"case",sourceKind:"asset",case:testCase}};
const caseInvocation: DebugInvocation = {mode:"case",locator,case:testCase};

describe("recorded debug identity", () => {
  it("matches the entire asset path, case scope and replay identity", () => {
    expect(facts(caseInvocation,caseResult)).toMatchObject({targetName:"Historical case",environmentName:"Historical environment",startedAt:history.startedAt});
    const others: DebugResult[] = [
      {...caseResult,source:{...base.source,locator:{...locator,groupId:"other"}}},
      {...caseResult,source:{...base.source,locator:{...locator,folderIds:[...locator.folderIds].reverse()}}},
      {...caseResult,source:{sourceKind:"unavailable"}},
      {...caseResult,replay:{...replay,mode:"case",sourceKind:"asset",case:{...testCase,scope:"other-scope"}}},
      {...caseResult,replay:{...replay,mode:"case",sourceKind:"asset",case:{...testCase,apiId:"other-api"}}},
      {...caseResult,replay:{...replay,mode:"case",sourceKind:"asset"}},
    ];
    for (const other of others) expect(facts(caseInvocation,other)).toMatchObject({targetName:undefined,environmentName:undefined,startedAt:undefined});
  });

  it("recognizes the exact saved request and the exact free draft in its own project", () => {
    const saved: DebugInvocation={mode:"request",locator,...request};
    const savedResult: DebugResult={...base,mode:"request",replay:{...replay,mode:"request",sourceKind:"asset",locator}};
    expect(facts(saved,savedResult).targetName).toBe("Historical API");
    expect(facts(saved,caseResult).startedAt).toBeUndefined();
    const free: DebugInvocation={mode:"free",project:owner,draftId,...request};
    const source={sourceKind:"free" as const,project:owner,draftId,draftRevision:"recorded"};
    const freeResult: DebugResult={...base,mode:"free",source,replay:{...replay,mode:"free",sourceKind:"free",project:owner,draftId}};
    expect(facts(free,freeResult).environmentName).toBe("Historical environment");
    expect(facts(free,{...freeResult,source:{...source,draftId:"00000000-0000-4000-8000-000000000098"}}).startedAt).toBeUndefined();
    expect(facts(free,{...freeResult,source:{...source,project:{...owner,workspaceId:"elsewhere"}}}).environmentName).toBeUndefined();
  });

  it("reads the named API only from the specified folder of the verified snapshot", () => {
    const folder=collection.folders[0]!;
    const nested={...asset,contract:{...asset.contract,metadata:{...asset.contract.metadata,name:"Nested API"}}};
    const view: OnlineProjectView={project:{...project,collections:[{...collection,folders:[{...folder,apis:[nested]}]}]},problems:[],
      assets:{...scope,format:"contract-files-v1",contractProjectId:project.id,version:"1",manifestHash:"a".repeat(64),files:[]}};
    const saved: DebugInvocation={mode:"request",...request,locator:{...locator,folderIds:[folder.id]}};
    expect(facts(saved,undefined,view).targetName).toBe("Nested API");
    expect(facts({...saved,locator},undefined,view).targetName).toBeUndefined();
    expect(facts({...saved,locator:{...saved.locator,groupId:"other"}},undefined,view).targetName).toBeUndefined();
  });
});
