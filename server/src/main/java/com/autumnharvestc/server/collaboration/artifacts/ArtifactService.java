package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.access.*;
import com.autumnharvestc.server.collaboration.policy.CollaborationPolicyService;
import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import com.autumnharvestc.server.collaboration.runtime.*;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.store.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static org.springframework.http.HttpStatus.*;

/** Server-owned fixed candidates. Remote projection is always between, never inside, storage transactions. */
@Service
public class ArtifactService {
    private final SourceSnapshotReader sources;private final CollaborationPolicyService policies;private final ArtifactRepo records;
    private final CollaborationRuntimeClient runtime;private final ObjectMapper json;private final CollaborationTime time;
    private final ProjectAccessService access;private final AccessRepo accessRecords;private final UserRepo users;private final AclRepo acl;private final TransactionTemplate transactions;
    private final CollaborationStorage storage;
    public ArtifactService(SourceSnapshotReader sources,CollaborationPolicyService policies,ArtifactRepo records,CollaborationRuntimeClient runtime,ObjectMapper json,CollaborationTime time,
            ProjectAccessService access,AccessRepo accessRecords,UserRepo users,AclRepo acl,PlatformTransactionManager transactions,CollaborationStorage storage){
        this.sources=sources;this.policies=policies;this.records=records;this.runtime=runtime;this.json=json;this.time=time;this.access=access;this.accessRecords=accessRecords;this.users=users;this.acl=acl;this.transactions=new TransactionTemplate(transactions);this.storage=storage;
    }
    private record Fixed(long workspace,long project,long actor,ArtifactViews.Source source,ArtifactViews.AccessIdentity access,PolicyReadView policy,JsonNode input,String operation,boolean evidence,long deadline) {}
    public ArtifactViews.Preview preview(UserAccount actor,String workspace,String project,JsonNode request){
        return preview(actor,workspace,project,request,null);
    }
    public ArtifactViews.Preview preview(UserAccount actor,String workspace,String project,JsonNode request,Long entryDeadline){
        Instant started=time.now();var fixed=transactions.execute(tx->fixed(actor,workspace,project,request,started,entryDeadline));
        deadline(fixed.deadline());var payload=json.createObjectNode();payload.set("input",fixed.input());payload.set("policy",projectionPolicy(fixed.policy(),fixed.evidence()));
        JsonNode artifact;
        try{artifact=runtime.call(fixed.operation(),payload,fixed.deadline(),Math.toIntExact(number(fixed.policy(),PolicyReadView.Code.RPC_MAX_MESSAGE_BYTES)));}
        catch(CollaborationRuntimeClient.Failure failure){throw failure.code().equals("RPC_DEADLINE_EXCEEDED")?error(REQUEST_TIMEOUT,"publication_deadline_exceeded"):error(SERVICE_UNAVAILABLE,"collaboration_projection_unavailable");}
        verifyProjection(fixed.source(),artifact);deadline(fixed.deadline());
        byte[] body=bytes(artifact);if(body.length>number(fixed.policy(),PolicyReadView.Code.MAX_ARTIFACT_BYTES))throw error(CONFLICT,"artifact_size_limit");String digest=Hashes.sha256Hex(body);
        var result=transactions.execute(tx->{var current=policies.publicationSnapshot(fixed.workspace(),fixed.project());deadline(fixed.deadline());
            requirePurpose(actor,fixed.workspace(),fixed.project());requireRead(actor,fixed.workspace(),fixed.project(),fixed.source().kind());
            sameAccess(fixed.access(),access(actor,fixed.workspace(),fixed.project()));samePolicy(fixed.policy(),current);
            storage.lockScope(fixed.workspace(),fixed.project());
            verifySource(actor,fixed.workspace(),fixed.project(),fixed.source(),current);records.lockProject(fixed.workspace(),fixed.project());deadline(fixed.deadline());Instant now=Instant.ofEpochMilli(time.now().toEpochMilli());
            storage.previewAdmission(actor.id(),fixed.workspace(),fixed.project(),current);
            long id=records.addCandidate(fixed.workspace(),fixed.project(),fixed.actor(),fixed.source(),fixed.access(),fixed.policy(),digest,body,now,now.plusMillis(number(fixed.policy(),PolicyReadView.Code.PREVIEW_TTL_MS)),fixed.deadline());storage.createdPreview(actor.id(),id,current);return preview(records.candidate(id,false,number(current,PolicyReadView.Code.MAX_ARTIFACT_BYTES)));});
        return result;
    }
    private Fixed fixed(UserAccount actor,String workspace,String project,JsonNode request,Instant started,Long entryDeadline){
        long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project);var policy=policies.publicationSnapshot(ws,pid);requirePurpose(actor,ws,pid);
        var command=ArtifactRequests.preview(request);var identity=access(actor,ws,pid);long deadline=entryDeadline==null?started.toEpochMilli()+number(policy,PolicyReadView.Code.PUBLICATION_OPERATION_TIMEOUT_MS):entryDeadline;deadline(deadline);
        var input=json.createObjectNode();ArtifactViews.Source source;String operation;
        feature(policy,command.source() instanceof ArtifactRequests.Report,command.includeEvidence());
        if(command.source() instanceof ArtifactRequests.Report descriptor){
            var report=sources.report(actor,workspace,project,descriptor.jobId(),number(policy,PolicyReadView.Code.MAX_SOURCE_BYTES));
            source=new ArtifactViews.Source("server-report",String.valueOf(report.execution()),report.hash(),null,new ArtifactViews.ReportIdentity(String.valueOf(report.id()),String.valueOf(report.execution()),String.valueOf(report.agent()),String.valueOf(report.creator()),String.valueOf(report.snapshot())));
            input.put("sourceKind","server-archive").put("title",command.title()).put("redaction","unavailable");input.putArray("privateMarkers");input.putObject("source").put("revision",source.revision()).put("digest",source.digest());
            input.putObject("report").put("format",report.reportKind()==null?"run":report.reportKind()).set("body",records.tree(report.body()));operation="project-report";
        }else{
            var descriptor=(ArtifactRequests.Document)command.source();var document=sources.document(actor,workspace,project,descriptor.revision(),descriptor.manifestHash(),number(policy,PolicyReadView.Code.MAX_SOURCE_BYTES));
            source=new ArtifactViews.Source("document",document.version(),document.manifestHash(),descriptor.scope(),null);
            input.put("sourceKind","saved-contract").put("title",command.title());input.putObject("source").put("revision",source.revision()).put("digest",source.digest());input.set("scope",source.scope());var files=input.putArray("files");for(var file:document.files())files.addObject().put("path",file.path()).put("content",file.content());operation="project-document";
        }
        deadline(deadline);return new Fixed(ws,pid,actor.id(),source,identity,policy,input,operation,command.includeEvidence(),deadline);
    }
    public record Confirmation(ArtifactViews.Publication publication,boolean replay) {}
    public Confirmation confirm(UserAccount actor,String workspace,String project,JsonNode request){
        Instant started=time.now();
        var result=transactions.execute(tx->{long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project);var policy=policies.publicationSnapshot(ws,pid);
            long operationDeadline=started.toEpochMilli()+number(policy,PolicyReadView.Code.PUBLICATION_OPERATION_TIMEOUT_MS);deadline(operationDeadline);requirePurpose(actor,ws,pid);
            var command=ArtifactRequests.confirm(request);storage.lockScope(ws,pid);records.lockProject(ws,pid);deadline(operationDeadline);
            var existing=records.intent(ws,pid,command.publicationIntentId(),number(policy,PolicyReadView.Code.MAX_ARTIFACT_BYTES));
            if(existing!=null){if(existing.preview()!=command.previewId()||existing.actor()!=actor.id()||!existing.digest().equals(command.candidateDigest()))throw error(CONFLICT,"publication_intent_conflict");requireRead(actor,ws,pid,existing.kind().equals("document")?"document":"server-report");return new Confirmation(publication(existing),true);}
            var candidate=requireCandidate(ws,pid,command.previewId(),false,policy);if(candidate.actor()!=actor.id())throw error(FORBIDDEN,"preview_actor_mismatch");
            requireRead(actor,ws,pid,candidate.source().kind());
            if(!candidate.digest().equals(command.candidateDigest())||!candidate.digest().equals(Hashes.sha256Hex(candidate.body())))throw error(CONFLICT,"candidate_digest_mismatch");
            if(!candidate.state().equals("pending"))throw error(CONFLICT,"preview_not_pending");
            if(!time.now().isBefore(candidate.expiresAt()))throw error(GONE,"preview_expired");
            if(command.expectedPolicyRevision()!=candidate.policy().projectionRevision())throw error(CONFLICT,"publication_policy_changed");
            sameAccess(candidate.access(),access(actor,ws,pid));samePolicy(candidate.policy(),policy);
            verifySource(actor,ws,pid,candidate.source(),policy);candidate=requireCandidate(ws,pid,candidate.id(),true,policy);deadline(operationDeadline);storage.versionAdmission(ws,pid,policy);
            long id=records.publish(candidate,command.publicationIntentId(),Instant.ofEpochMilli(time.now().toEpochMilli()));storage.confirmed(actor.id(),candidate.id(),id,policy);return new Confirmation(publication(records.publication(id,number(policy,PolicyReadView.Code.MAX_ARTIFACT_BYTES))),false);});
        return result;
    }
    public ArtifactViews.Preview preview(UserAccount actor,String workspace,String project,String id){return transactions.execute(tx->{long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project);var policy=policies.publicationSnapshot(ws,pid);requireRead(actor,ws,pid,"document");storage.lockScope(ws,pid);records.lockProject(ws,pid);
        receipt(actor,ws,pid,EntityIds.parse(id));var candidate=requireCandidate(ws,pid,EntityIds.parse(id),false,policy);requireCandidateManager(actor,ws,pid,candidate);requireRead(actor,ws,pid,candidate.source().kind());return preview(candidate);});}
    public void cancel(UserAccount actor,String workspace,String project,String id){
        transactions.executeWithoutResult(tx->{
            long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project),previewId=EntityIds.parse(id);
            policies.publicationSnapshot(ws,pid);
            requireRead(actor,ws,pid,"document");
            storage.lockScope(ws,pid);
            records.lockProject(ws,pid);
            var state=receipt(actor,ws,pid,previewId);
            if(state.state().equals("pending")){
                records.terminal(previewId,"cancelled",time.now());
                storage.cancelled(actor.id(),previewId);
            }
        });
    }
    public ArtifactViews.Publication publication(UserAccount actor,String workspace,String project,String id){return transactions.execute(tx->{long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project);var policy=policies.publicationSnapshot(ws,pid);requireRead(actor,ws,pid,"document");storage.lockScope(ws,pid);records.lockProject(ws,pid);
        var value=records.publication(EntityIds.parse(id),number(policy,PolicyReadView.Code.MAX_ARTIFACT_BYTES));if(value==null||value.workspace()!=ws||value.project()!=pid)throw error(NOT_FOUND,"publication_not_found");requireRead(actor,ws,pid,value.kind().equals("document")?"document":"server-report");return publication(value);});}
    public ArtifactViews.Page list(UserAccount actor,String workspace,String project){return new ArtifactViews.Page(records.list(EntityIds.parse(workspace),EntityIds.parse(project)));}
    public ArtifactViews.Operation operation(UserAccount actor,String workspace,String project,String intent){
        return transactions.execute(tx->{
            long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project);
            policies.publicationSnapshot(ws,pid);
            requireRead(actor,ws,pid,"document");
            var publication=records.intentHead(ws,pid,intent);
            if(publication==null)throw error(NOT_FOUND,"operation_not_found");
            if(publication.actor()!=actor.id())requirePreviewManagement(actor,ws,pid,publication.kind());
            return new ArtifactViews.Operation(intent,"committed",String.valueOf(publication.id()),publication.digest());
        });
    }
    private ArtifactRepo.PreviewState receipt(UserAccount actor,long workspace,long project,long id){
        var state=records.previewState(id);
        if(state==null||state.workspace()!=workspace||state.project()!=project)throw error(NOT_FOUND,"preview_not_found");
        if(state.actor()!=actor.id())requirePreviewManagement(actor,workspace,project,state.kind());
        if(state.receiptRetireAt()!=null){
            boolean retained=time.now().toEpochMilli()<state.receiptRetireAt();
            throw error(retained?GONE:NOT_FOUND,retained?"preview_expired":"preview_not_found");
        }
        return state;
    }
    private ArtifactRepo.Candidate requireCandidate(long workspace,long project,long id,boolean locked,PolicyReadView policy){var state=records.previewState(id);if(state==null||state.workspace()!=workspace||state.project()!=project)throw error(NOT_FOUND,"preview_not_found");if(state.receiptRetireAt()!=null)throw error(GONE,"preview_expired");var value=records.candidate(id,locked,number(policy,PolicyReadView.Code.MAX_ARTIFACT_BYTES));if(value==null)throw error(NOT_FOUND,"preview_not_found");return value;}
    private void requireCandidateManager(UserAccount actor,long workspace,long project,ArtifactRepo.Candidate candidate){if(candidate.actor()!=actor.id())requirePreviewManagement(actor,workspace,project,candidate.source().kind());}
    ProjectAccessView requireRead(UserAccount actor,long workspace,long project,String kind){
        var decision=access.resolve(actor.id(),workspace,project);
        if(!decision.accountEnabled()||!decision.member()||decision.effectiveRole().isEmpty()||(!Set.of("document","mock","member-upload").contains(kind)&&!decision.capabilities().contains(Capability.HISTORY_READ)))throw error(FORBIDDEN,"forbidden");return decision;
    }
    private void requirePurpose(UserAccount actor,long workspace,long project){if(!requireRead(actor,workspace,project,"document").capabilities().contains(Capability.PUBLICATION_MANAGE))throw error(FORBIDDEN,"forbidden");}
    void requirePurpose(UserAccount actor,long workspace,long project,String kind){requireManagement(actor,workspace,project,kind);requireRead(actor,workspace,project,kind);}
    void requireManagement(UserAccount actor,long workspace,long project,String kind){var decision=requireRead(actor,workspace,project,"document");var capability=kind.equals("member-upload")?Capability.HISTORY_PUBLISH:kind.equals("mock")?Capability.MOCK_MANAGE:Capability.PUBLICATION_MANAGE;if(!decision.capabilities().contains(capability))throw error(FORBIDDEN,"forbidden");}
    void requirePreviewManagement(UserAccount actor,long workspace,long project,String kind){requireManagement(actor,workspace,project,kind.equals("mock")?"mock":"document");}
    private void verifySource(UserAccount actor,long workspace,long project,ArtifactViews.Source source,PolicyReadView policy){
        if(source.kind().equals("document"))sources.document(actor,String.valueOf(workspace),String.valueOf(project),source.revision(),source.digest(),number(policy,PolicyReadView.Code.MAX_SOURCE_BYTES));
        else{var report=sources.report(actor,String.valueOf(workspace),String.valueOf(project),source.report().jobId(),number(policy,PolicyReadView.Code.MAX_SOURCE_BYTES));
            var identity=new ArtifactViews.ReportIdentity(String.valueOf(report.id()),String.valueOf(report.execution()),String.valueOf(report.agent()),String.valueOf(report.creator()),String.valueOf(report.snapshot()));
            if(!source.revision().equals(String.valueOf(report.execution()))||!source.digest().equals(report.hash())||!source.report().equals(identity))throw error(CONFLICT,"publication_source_changed");}
    }
    void sameAccess(ArtifactViews.AccessIdentity before,ArtifactViews.AccessIdentity current){if(!before.equals(current))throw error(CONFLICT,"publication_access_changed");}
    void samePolicy(PolicyReadView before,PolicyReadView current){if(!before.identity().equals(current.identity()))throw error(CONFLICT,"publication_policy_changed");}
    void feature(PolicyReadView policy,boolean report,boolean evidence){
        if(report&&!allowed(policy,PolicyReadView.Code.HISTORY_PUBLISHING_ALLOWED))throw error(FORBIDDEN,"publication_policy_disabled");
        if(evidence&&!allowed(policy,PolicyReadView.Code.EVIDENCE_ALLOWED))throw error(FORBIDDEN,"publication_evidence_not_allowed");
    }
    private void verifyProjection(ArtifactViews.Source source,JsonNode artifact){String kind=source.kind().equals("document")?"document":"report",trust=source.kind().equals("document")?"saved-contract":"server-archive";
        if(!artifact.path("kind").asText().equals(kind)||!artifact.at("/source/trust").asText().equals(trust)||!artifact.at("/source/revision").asText().equals(source.revision())||!artifact.at("/source/digest").asText().equals(source.digest()))throw error(BAD_GATEWAY,"publication_projection_mismatch");}
    void deadline(long deadline){if(time.now().toEpochMilli()>=deadline)throw error(REQUEST_TIMEOUT,"publication_deadline_exceeded");}
    static boolean allowed(PolicyReadView view,PolicyReadView.Code code){return ((PolicyReadView.BooleanSetting)view.settings().stream().filter(item->item.code()==code).findFirst().orElseThrow()).effective();}
    static ApiException error(org.springframework.http.HttpStatus status,String code){return new ApiException(status,code,switch(code){
        case "forbidden"->"当前账号没有此项目操作或来源读取权限";case "preview_not_found"->"预览不存在于当前项目";case "publication_not_found"->"固定版本不存在于当前项目";case "operation_not_found"->"发布操作不存在于当前项目";
        case "publication_deadline_exceeded"->"发布操作预算已耗尽，请重新发起";case "preview_expired"->"预览已过期，请重新生成";case "collaboration_projection_unavailable"->"协作投影服务暂不可用";default->"发布绑定状态已变化或不满足当前策略，请重新预览";});}
    private ArtifactViews.Preview preview(ArtifactRepo.Candidate value){return value==null?null:new ArtifactViews.Preview(String.valueOf(value.id()),value.state(),value.digest(),value.policy().projectionRevision(),value.expiresAt().toString(),records.tree(value.body()),ArtifactConstraints.preview(value.policy()));}
    private ArtifactViews.Publication publication(ArtifactRepo.Publication value){return value==null?null:new ArtifactViews.Publication(String.valueOf(value.id()),value.version(),value.digest(),value.kind(),value.trust(),String.valueOf(value.actor()),value.createdAt().toString(),records.tree(value.body()),value.revision(),value.enabled(),RemainingArtifacts.source(value.source()));}
    ArtifactViews.AccessIdentity access(UserAccount actor,long workspace,long project){
        var decision=access.resolve(actor.id(),workspace,project);
        return new ArtifactViews.AccessIdentity(users.stateRevision(actor.id()),accessRecords.memberRevision(workspace,actor.id()),acl.revision(workspace,project,actor.id()),accessRecords.policyRevision(workspace,0),accessRecords.policyRevision(workspace,project),decision.accessRevision(),decision.membershipEpoch(),decision.responsibilityEpoch(),decision.accountEnabled(),decision.member(),decision.workspaceRole().orElse(null),decision.projectOverride().orElse(null),decision.overrideState(),decision.effectiveRole().orElse(null),decision.capabilities().stream().sorted(Comparator.comparing(Capability::code)).toList());
    }
    private ObjectNode projectionPolicy(PolicyReadView view,boolean evidence){
        var result=json.createObjectNode().put("revision",view.projectionRevision()).put("includeEvidence",evidence).put("maxFieldBytes",number(view,PolicyReadView.Code.MAX_FIELD_BYTES)).put("maxEvidenceBytes",number(view,PolicyReadView.Code.MAX_EVIDENCE_BYTES)).put("maxArtifactBytes",number(view,PolicyReadView.Code.MAX_ARTIFACT_BYTES));
        for(var item:view.settings())if(item instanceof PolicyReadView.StringListSetting list&&list.code()!=PolicyReadView.Code.CORS_ALLOWED_ORIGINS)result.set(list.code().code(),json.valueToTree(list.effective()));return result;
    }
    private static long number(PolicyReadView view,PolicyReadView.Code code){return ((PolicyReadView.IntegerSetting)view.settings().stream().filter(item->item.code()==code).findFirst().orElseThrow()).effective();}
    private byte[] bytes(JsonNode value){try{return json.writeValueAsBytes(value);}catch(java.io.IOException invalid){throw new IllegalStateException("Cannot encode strict artifact DTO",invalid);}}
}
