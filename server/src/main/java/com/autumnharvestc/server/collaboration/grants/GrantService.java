package com.autumnharvestc.server.collaboration.grants;

import com.autumnharvestc.server.access.ProjectAccessService;
import com.autumnharvestc.server.access.Capability;
import com.autumnharvestc.server.collaboration.artifacts.*;
import com.autumnharvestc.server.collaboration.policy.CollaborationPolicyService;
import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.Hashes;
import com.autumnharvestc.server.store.UserAccount;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import static org.springframework.http.HttpStatus.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class GrantService {
    private final GrantRepo grants;
    private final ArtifactRepo artifacts;
    private final CollaborationPolicyService policies;
    private final ProjectAccessService access;
    private final CollaborationStorage storage;
    private final CollaborationTime time;
    private final TransactionTemplate tx;
    private final com.autumnharvestc.server.collaboration.publicapi.PublicAccessProperties publicSettings;
    private final org.springframework.core.env.Environment environment;
    private final SecureRandom random=new SecureRandom();
    private final com.autumnharvestc.server.store.TokenRepo tokens;
    private final com.autumnharvestc.server.store.UserRepo users;
    private final com.autumnharvestc.server.auth.TokenService tokenService;
    private final com.autumnharvestc.server.collaboration.publicapi.PublicReadLimiter readLimits;
    private final com.autumnharvestc.server.collaboration.publicapi.PublicAdmissionState publicAdmission;
    public GrantService(GrantRepo grants,ArtifactRepo artifacts,CollaborationPolicyService policies,ProjectAccessService access,
            CollaborationStorage storage,CollaborationTime time,PlatformTransactionManager manager,
            com.autumnharvestc.server.collaboration.publicapi.PublicAccessProperties publicSettings,org.springframework.core.env.Environment environment,
            com.autumnharvestc.server.store.TokenRepo tokens,com.autumnharvestc.server.store.UserRepo users,com.autumnharvestc.server.auth.TokenService tokenService,
            com.autumnharvestc.server.collaboration.publicapi.PublicReadLimiter readLimits,com.autumnharvestc.server.collaboration.publicapi.PublicAdmissionState publicAdmission) {
        this.grants=grants;this.artifacts=artifacts;this.policies=policies;this.access=access;this.storage=storage;this.time=time;
        this.tx=new TransactionTemplate(manager);this.publicSettings=publicSettings;this.environment=environment;
        this.tokens=tokens;this.users=users;this.tokenService=tokenService;
        this.readLimits=readLimits;this.publicAdmission=publicAdmission;
    }
    public record CommandResult(Map<String,Object> value,boolean replay){}
    /** Internal finite admission, never serialized to a public caller; T8 consumes call bodies without auth headers. */
    public record Admission(long workspaceId,long projectId,long publicationId,long version,byte[] body,PolicyReadView policy,boolean downloadAllowed,AutoCloseable lease) implements AutoCloseable {
        @Override public void close(){try{lease.close();}catch(Exception failure){throw new IllegalStateException("Cannot release public admission",failure);}}
    }
    private record Outcome(Admission admission,String inactive){}
    public Admission admit(String publicId,String key,String purpose,boolean download,String authorization){
        var initial=grants.publicGrant(publicId);verifyKey(initial,key,purpose);
        var lease=new java.util.concurrent.atomic.AtomicReference<com.autumnharvestc.server.collaboration.publicapi.PublicReadLimiter.Lease>();
        try{
        var result=tx.execute(status->{
            var policy=policies.publicationSnapshot(initial.workspace(),initial.project());
            storage.lockScope(initial.workspace(),initial.project());artifacts.lockProject(initial.workspace(),initial.project());
            var grant=grants.find(initial.id(),true);verifyKey(grant,key,purpose);
            if(!publicConfigured())throw error(SERVICE_UNAVAILABLE,"public_origin_unavailable");
            if(grant.audience().equals("members")){
                if(!purpose.equals("call"))throw unavailable();
                var member=member(authorization);requireContent(member.id(),grant.workspace(),grant.project());
            }
            var head=artifacts.head(grant.publication(),true);
            String inactive=inactive(grant,head,policy);
            if(inactive!=null){
                if(inactive.equals("expired")||inactive.equals("policy_changed")){
                    long ended=inactive.equals("expired")?grant.expiresAt():time.now().toEpochMilli();
                    end(null,grant,inactive,ended,policy,StorageTypes.Action.GRANT_INVALIDATED);
                }
                return new Outcome(null,inactive);
            }
            if(download&&(!grant.downloadAllowed()||!allowed(policy,PolicyReadView.Code.EXTERNAL_DOWNLOAD_ALLOWED)))throw unavailable();
            if(purpose.equals("view"))lease.set(readLimits.acquire(grant.id(),policy,time.now().toEpochMilli()));
            var fixed=saved(grant.publication());
            return new Outcome(new Admission(grant.workspace(),grant.project(),fixed.id(),fixed.version(),fixed.body(),policy,grant.downloadAllowed()&&allowed(policy,PolicyReadView.Code.EXTERNAL_DOWNLOAD_ALLOWED),lease.get()==null?()->{}:lease.get()),null);
        });
        if(result.inactive()!=null)throw new ShareInactive(result.inactive());
        return result.admission();
        }catch(RuntimeException failure){if(lease.get()!=null)lease.get().close();throw failure;}
    }
    private static void verifyKey(GrantRepo.Grant grant,String key,String purpose){
        if(grant==null||key==null||key.length()!=43||grant.keyHash()==null||!MessageDigest.isEqual(grant.keyHash(),hash(key))||!grant.purpose().equals(purpose))throw unavailable();
    }
    private UserAccount member(String authorization){
        if(authorization==null||!authorization.regionMatches(true,0,"Bearer ",0,7))throw error(UNAUTHORIZED,"unauthorized");
        var token=tokens.findActiveByHash(tokenService.sha256Hex(authorization.substring(7).trim()));
        var user=token.flatMap(value->users.findById(value.userId())).filter(value->!value.disabled());
        return user.orElseThrow(()->error(UNAUTHORIZED,"unauthorized"));
    }
    private String inactive(GrantRepo.Grant grant,ArtifactRepo.PublicationHead head,PolicyReadView policy){
        if(!grant.state().equals("active"))return grant.reason();
        if(time.now().toEpochMilli()>=grant.expiresAt())return "expired";
        if(head==null||!head.enabled())return "publication_disabled";
        var current=access.resolve(grant.responsible(),grant.workspace(),grant.project());
        if(current.responsibilityEpoch()!=grant.responsibilityEpoch())return "responsibility_changed";
        try{requireQualification(grant.responsible(),grant.workspace(),grant.project(),head.kind());}catch(ApiException denied){return "responsibility_changed";}
        return compliant(grant,policy)?null:"policy_changed";
    }
    private boolean compliant(GrantRepo.Grant grant,PolicyReadView policy){
        if(grant.audience().equals("external")&&!allowed(policy,PolicyReadView.Code.EXTERNAL_SHARING_ALLOWED))return false;
        if(grant.expiresAt()-grant.createdAt()>CollaborationStorage.number(policy,PolicyReadView.Code.MAX_SHARE_DURATION_MS))return false;
        return fixedCompliant(artifacts.publication(grant.publication(),-1),policy);
    }
    private boolean fixedCompliant(ArtifactRepo.Publication fixed,PolicyReadView policy) {
        if(!allowed(policy,PolicyReadView.Code.EVIDENCE_ALLOWED)
                &&Set.of("report","debug-history").contains(fixed.kind())
                &&artifacts.tree(saved(fixed.id()).body()).at("/report/evidence").size()>0) {
            return false;
        }
        for(var code:List.of(PolicyReadView.Code.EXTRA_SENSITIVE_HEADERS,PolicyReadView.Code.EXTRA_SENSITIVE_QUERY,
                PolicyReadView.Code.EXTRA_SENSITIVE_FIELDS,PolicyReadView.Code.EXTRA_SENSITIVE_POINTERS)) {
            var original=(PolicyReadView.StringListSetting)fixed.policy().settings().stream()
                .filter(setting->setting.code()==code).findFirst().orElseThrow();
            var current=(PolicyReadView.StringListSetting)policy.settings().stream()
                .filter(setting->setting.code()==code).findFirst().orElseThrow();
            if(!original.effective().containsAll(current.effective()))return false;
        }
        return true;
    }
    public CommandResult create(UserAccount actor,String workspace,String project,String publication,JsonNode request) {
        return tx.execute(status->{
            long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project),publicationId=EntityIds.parse(publication);
            var policy=policies.publicationSnapshot(ws,pid);
            var decision=requireContent(actor.id(),ws,pid);
            storage.lockScope(ws,pid);artifacts.lockProject(ws,pid);
            var fixed=artifacts.publication(publicationId,-1);
            if(fixed==null||fixed.workspace()!=ws||fixed.project()!=pid)throw error(NOT_FOUND,"publication_not_found");
            requireQualification(actor.id(),ws,pid,fixed.kind());
            var command=GrantRequests.create(request);
            String purpose=command.purpose(),audience=command.audience();
            if(fixed.kind().equals("mock")!=purpose.equals("call"))throw GrantRequests.invalid();
            String fingerprint=Hashes.sha256Hex((publicationId+":"+command).getBytes(StandardCharsets.UTF_8));
            var operation=grants.operation(ws,pid,command.intent());
            if(operation!=null){
                if(operation.actor()!=actor.id()||!operation.command().equals("create")||!operation.fingerprint().equals(fingerprint))throw error(CONFLICT,"grant_intent_conflict");
                return new CommandResult(view(grants.find(operation.grant(),false),null),true);
            }
            if(fixed.revision()!=command.expectedRevision())throw error(CONFLICT,"publication_revision_conflict");
            if(!fixed.enabled())throw error(CONFLICT,"grant_publication_disabled");
            if(audience.equals("external")&&!allowed(policy,PolicyReadView.Code.EXTERNAL_SHARING_ALLOWED))throw error(FORBIDDEN,"grant_policy_disabled");
            if(!fixedCompliant(fixed,policy))throw error(FORBIDDEN,"grant_policy_disabled");
            if(audience.equals("external")&&!publicConfigured())throw error(SERVICE_UNAVAILABLE,"public_origin_unavailable");
            if(command.download()&&!allowed(policy,PolicyReadView.Code.EXTERNAL_DOWNLOAD_ALLOWED))throw error(FORBIDDEN,"grant_policy_disabled");
            boolean secret=!(purpose.equals("view")&&audience.equals("members"));
            String publicId=secret?random(16):null,key=secret?random(32):null;
            long now=time.now().toEpochMilli(),expiry=command.durationMs()!=null?now+command.durationMs():command.expiresAt()==null?now+CollaborationStorage.number(policy,PolicyReadView.Code.DEFAULT_SHARE_DURATION_MS):command.expiresAt();
            if(expiry-now<60000||expiry-now>CollaborationStorage.number(policy,PolicyReadView.Code.MAX_SHARE_DURATION_MS))throw GrantRequests.invalid();
            if(audience.equals("external")&&(grants.activeExternal(null,null,now)>=CollaborationStorage.number(policy,PolicyReadView.Code.DEPLOYMENT_MAX_ACTIVE_GRANTS)||grants.activeExternal(ws,pid,now)>=CollaborationStorage.number(policy,PolicyReadView.Code.MAX_PROJECT_ACTIVE_GRANTS)))throw error(CONFLICT,"collaboration_grant_limit");
            long id=grants.create(ws,pid,publicationId,fixed.version(),purpose,audience,actor.id(),decision.responsibilityEpoch(),publicId,key==null?null:hash(key),now,expiry,command.download(),command.intent());
            long operationId=grants.operation(ws,pid,command.intent(),actor.id(),id,"create",fingerprint,1,1);
            var grant=grants.find(id,false);
            storage.grantCreated(actor.id(),ws,pid,id,grant,policy);
            storage.grantOperation(ws,pid,operationId,command.intent(),grants.operation(ws,pid,command.intent()),policy);
            storage.retain(actor.id(),ws,pid,new StorageTypes.StoredKey(StorageTypes.Kind.ARTIFACT,publicationId),new StorageTypes.Owner(StorageTypes.OwnerKind.GRANT,id,java.time.Instant.ofEpochMilli(expiry)));
            return new CommandResult(view(grant,key),false);
        });
    }
    public Map<String,Object> operation(UserAccount actor,String workspace,String project,String intent){
        return tx.execute(status->{long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project);policies.publicationSnapshot(ws,pid);requireContent(actor.id(),ws,pid);
            var operation=grants.operation(ws,pid,intent);if(operation==null||operation.actor()!=actor.id())throw error(NOT_FOUND,"grant_operation_not_found");
            var grant=grants.find(operation.grant(),false);requireManagement(actor.id(),ws,pid,grant.purpose());
            return Map.of("grantId",String.valueOf(operation.grant()),"command",operation.command(),"revision",operation.revision(),"generation",operation.generation(),"keyObtained",false);
        });
    }
    public Map<String,Object> read(UserAccount actor,String workspace,String project,String id){
        return tx.execute(status->{long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project);policies.publicationSnapshot(ws,pid);return view(manage(actor,ws,pid,EntityIds.parse(id)),null);});
    }
    public Map<String,Object> list(UserAccount actor,String workspace,String project,String publication,Map<String,String> query){
        return tx.execute(status->{
            long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project),publicationId=EntityIds.parse(publication);
            var policy=policies.publicationSnapshot(ws,pid);requireContent(actor.id(),ws,pid);
            var fixed=artifacts.head(publicationId,false);
            if(fixed==null||fixed.workspace()!=ws||fixed.project()!=pid)throw error(NOT_FOUND,"publication_not_found");
            requireManagement(actor.id(),ws,pid,fixed.kind().equals("mock")?"call":"view");
            if(!Set.of("cursor","limit").containsAll(query.keySet()))throw GrantRequests.invalid();
            int limit=(int)CollaborationStorage.number(policy,PolicyReadView.Code.DEFAULT_PAGE_SIZE);
            try{if(query.containsKey("limit"))limit=Integer.parseInt(query.get("limit"));}catch(NumberFormatException failure){throw GrantRequests.invalid();}
            if(limit<1||limit>CollaborationStorage.number(policy,PolicyReadView.Code.MAX_PAGE_SIZE))throw GrantRequests.invalid();
            long high,before=Long.MAX_VALUE;
            if(query.containsKey("cursor")){
                long[] fields=grantCursor(query.get("cursor"));
                if(fields[0]!=ws||fields[1]!=pid||fields[2]!=publicationId||fields[3]!=limit)throw cursorInvalid();
                high=fields[4];before=fields[5];
            }else high=grants.publicationHighWater(ws,pid,publicationId);
            var rows=grants.publicationPage(ws,pid,publicationId,high,before,limit+1);
            var page=rows.subList(0,Math.min(limit,rows.size()));String next="";
            if(rows.size()>limit){String raw="grants:"+ws+":"+pid+":"+publicationId+":"+limit+":"+high+":"+page.getLast().id();next=Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.US_ASCII));}
            return Map.of("items",page.stream().map(grant->view(grant,null)).toList(),"nextCursor",next,"constraints",ArtifactConstraints.grant(policy));
        });
    }
    private long[] grantCursor(String encoded){
        try{
            if(encoded.length()>256)throw cursorInvalid();
            String[] fields=new String(Base64.getUrlDecoder().decode(encoded),StandardCharsets.US_ASCII).split(":",-1);
            if(fields.length!=7||!fields[0].equals("grants"))throw cursorInvalid();
            long[] values=new long[6];for(int index=0;index<values.length;index++){values[index]=Long.parseLong(fields[index+1]);if(values[index]<=0)throw cursorInvalid();}
            return values;
        }catch(IllegalArgumentException failure){throw cursorInvalid();}
    }
    private ApiException cursorInvalid(){return error(BAD_REQUEST,"collaboration_cursor_invalid");}
    private GrantRepo.Grant manage(UserAccount actor,long ws,long project,long id){
        requireContent(actor.id(),ws,project);
        var grant=grants.find(id,false);
        if(grant==null||grant.workspace()!=ws||grant.project()!=project)throw error(NOT_FOUND,"grant_not_found");
        requireManagement(actor.id(),ws,project,grant.purpose());return grant;
    }
    public CommandResult rotate(UserAccount actor,String workspace,String project,String id,JsonNode request){
        return tx.execute(status->{
            long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project),grantId=EntityIds.parse(id);var policy=policies.publicationSnapshot(ws,pid);
            manage(actor,ws,pid,grantId);GrantRequests.fields(request,Set.of("operationIntent","expectedRevision"));
            String intent=GrantRequests.intent(request);long expected=GrantRequests.revision(request);
            String fingerprint=Hashes.sha256Hex((grantId+":"+expected).getBytes(StandardCharsets.US_ASCII));
            storage.lockScope(ws,pid);artifacts.lockProject(ws,pid);var grant=grants.find(grantId,true);
            var operation=grants.operation(ws,pid,intent);
            if(operation!=null){
                if(operation.actor()!=actor.id()||!operation.command().equals("rotate")||!operation.fingerprint().equals(fingerprint))throw error(CONFLICT,"grant_intent_conflict");
                return new CommandResult(view(grants.find(operation.grant(),false),null),true);
            }
            if(grant.revision()!=expected)throw error(CONFLICT,"grant_revision_conflict");
            if(grant.keyHash()==null)throw GrantRequests.invalid();
            if(inactive(grant,artifacts.head(grant.publication(),true),policy)!=null)throw error(CONFLICT,"grant_inactive");
            if(grant.revision()>=com.autumnharvestc.server.access.AccessRequests.MAX_REVISION||grant.generation()>=com.autumnharvestc.server.access.AccessRequests.MAX_REVISION)throw error(CONFLICT,"grant_revision_exhausted");
            if(grant.audience().equals("external")&&(grants.activeExternal(null,null,time.now().toEpochMilli())>CollaborationStorage.number(policy,PolicyReadView.Code.DEPLOYMENT_MAX_ACTIVE_GRANTS)||grants.activeExternal(ws,pid,time.now().toEpochMilli())>CollaborationStorage.number(policy,PolicyReadView.Code.MAX_PROJECT_ACTIVE_GRANTS)))throw error(CONFLICT,"collaboration_grant_limit");
            String key=random(32);grants.rotate(grantId,hash(key),intent);var updated=grants.find(grantId,false);
            long operationId=grants.operation(ws,pid,intent,actor.id(),grantId,"rotate",fingerprint,updated.revision(),updated.generation());
            storage.grantOperation(ws,pid,operationId,intent,grants.operation(ws,pid,intent),policy);
            storage.grantChanged(actor.id(),ws,pid,grantId,updated,policy,StorageTypes.Action.GRANT_ROTATED,false);
            return new CommandResult(view(updated,key),false);
        });
    }
    public void revoke(UserAccount actor,String workspace,String project,String id,JsonNode request){
        tx.executeWithoutResult(status->{long ws=EntityIds.parse(workspace),pid=EntityIds.parse(project),grantId=EntityIds.parse(id);var policy=policies.publicationSnapshot(ws,pid);
            manage(actor,ws,pid,grantId);GrantRequests.fields(request,Set.of("expectedRevision"));long expected=GrantRequests.revision(request);
            storage.lockScope(ws,pid);artifacts.lockProject(ws,pid);var grant=grants.find(grantId,true);
            if(grant.revision()!=expected)throw error(CONFLICT,"grant_revision_conflict");
            end(actor.id(),grant,"revoked",time.now().toEpochMilli(),policy,StorageTypes.Action.GRANT_REVOKED);
        });
    }
    private void end(Long actor,GrantRepo.Grant grant,String reason,long ended,PolicyReadView policy,StorageTypes.Action action){
        if(!grant.state().equals("active"))return;
        grants.inactivate(grant.id(),reason,Math.min(ended,grant.expiresAt()));
        storage.releaseGrant(actor,grant.workspace(),grant.project(),grant.id(),Math.min(ended,grant.expiresAt()));
        storage.grantChanged(actor,grant.workspace(),grant.project(),grant.id(),grants.find(grant.id(),false),policy,action,true);
    }
    /** Caller owns policy/access, quota and project locks; expiry and its reference/audit join that transaction. */
    public int expireDue(Long actor,long workspace,long project,Long publication,int limit,PolicyReadView policy){
        var due=grants.expiredPage(workspace,project,publication,time.now().toEpochMilli(),limit);
        for(var grant:due)end(actor,grant,"expired",grant.expiresAt(),policy,StorageTypes.Action.GRANT_INVALIDATED);
        return due.size();
    }
    /** Caller already holds policy then access gates; all accounts precede project/object/ref locks. */
    public void responsibilityLost(Long actor,List<com.autumnharvestc.server.access.AccessRepo.SubjectProject> subjects){
        var scopes=new TreeSet<GrantRepo.Scope>();for(var subject:subjects)scopes.add(new GrantRepo.Scope(subject.workspaceId(),subject.projectId()));
        for(var scope:scopes)storage.lockScope(scope.workspace(),scope.project());
        for(var scope:scopes)artifacts.lockProject(scope.workspace(),scope.project());
        var affected=new HashSet<>(subjects);
        for(var scope:scopes){var policy=policies.publicationSnapshot(scope.workspace(),scope.project());long after=0;
            while(true){var page=grants.activePage(scope.workspace(),scope.project(),after);if(page.isEmpty())break;
                for(var grant:page){after=grant.id();if(affected.contains(new com.autumnharvestc.server.access.AccessRepo.SubjectProject(grant.workspace(),grant.project(),grant.responsible())))end(actor,grant,"responsibility_changed",time.now().toEpochMilli(),policy,StorageTypes.Action.GRANT_INVALIDATED);}
            }
        }
    }
    public void policyApplied(Long actor,long workspace,Long project) {
        var scopes=grants.scopes(workspace,project);
        for(var scope:scopes)storage.lockScope(scope.workspace(),scope.project());
        for(var scope:scopes)artifacts.lockProject(scope.workspace(),scope.project());
        for(var scope:scopes) {
            var policy=policies.publicationSnapshot(scope.workspace(),scope.project());
            long after=0;
            while(true) {
                var page=grants.activePage(scope.workspace(),scope.project(),after);
                if(page.isEmpty())break;
                for(var grant:page) {
                    after=grant.id();
                    if(grant.expiresAt()<=time.now().toEpochMilli()) {
                        end(actor,grant,"expired",grant.expiresAt(),policy,StorageTypes.Action.GRANT_INVALIDATED);
                    } else if(!compliant(grant,policy)) {
                        end(actor,grant,"policy_changed",time.now().toEpochMilli(),policy,StorageTypes.Action.GRANT_INVALIDATED);
                    }
                }
            }
        }
    }
    /** Applied deployment restrictions are persisted even when the public listener is disabled. */
    public void reconcileAppliedDeployment(){
        tx.executeWithoutResult(status->{
            var policy=policies.publicationSnapshot(0,0);storage.lockScope(0,0);
            policyApplied(null,0,null);
            long now=time.now().toEpochMilli();String digest=policy.identity().deploymentDigest();
            boolean changed=grants.applied(digest,now);storage.deploymentPolicyApplied(digest,now,changed,policy);
        });
    }
    private ArtifactRepo.Publication saved(long id){
        var metadata=artifacts.publication(id,-1);
        // This ceiling applies to the immutable stored version; today's NEW_PUBLICATIONS budget is not retroactive.
        long maximum=Math.min(33_554_432L,CollaborationStorage.number(metadata.policy(),PolicyReadView.Code.MAX_ARTIFACT_BYTES));
        return artifacts.publication(id,maximum);
    }
    private static ApiException unavailable(){return error(NOT_FOUND,"share_unavailable");}
    /** Trusted storage seam: a GRANT enum is not proof of durable ownership or current qualification. */
    public long referenceExpiry(long workspace,long project,StorageTypes.StoredKey target,long grantId){
        var grant=grants.find(grantId,true);
        if(grant==null||grant.workspace()!=workspace||grant.project()!=project||target.kind()!=StorageTypes.Kind.ARTIFACT||grant.publication()!=target.id()
                ||!grant.state().equals("active")||grant.expiresAt()<=time.now().toEpochMilli())throw ownerInvalid();
        var head=artifacts.head(grant.publication(),true);
        if(head==null||head.workspace()!=workspace||head.project()!=project)throw ownerInvalid();
        var current=access.resolve(grant.responsible(),workspace,project);
        if(current.responsibilityEpoch()!=grant.responsibilityEpoch())throw ownerInvalid();
        try{requireQualification(grant.responsible(),workspace,project,head.kind());}catch(ApiException unavailable){throw ownerInvalid();}
        return grant.expiresAt();
    }
    private static ApiException ownerInvalid(){return error(CONFLICT,"collaboration_reference_owner_invalid");}
    public boolean publicConfigured(){return publicAdmission.ready()&&publicOriginConfigured();}
    public boolean publicOriginConfigured(){return publicSettings.configured(environment.getProperty("local.server.port",Integer.class,environment.getProperty("server.port",Integer.class,8080)));}
    private com.autumnharvestc.server.access.ProjectAccessView requireContent(long actor,long ws,long project){
        var decision=access.resolve(actor,ws,project);if(!decision.accountEnabled()||!decision.member()||decision.effectiveRole().isEmpty())throw error(FORBIDDEN,"forbidden");return decision;
    }
    private void requireManagement(long actor,long ws,long project,String purpose){if(!requireContent(actor,ws,project).capabilities().contains(purpose.equals("call")?Capability.MOCK_MANAGE:Capability.PUBLICATION_MANAGE))throw error(FORBIDDEN,"forbidden");}
    private void requireQualification(long actor,long ws,long project,String kind){
        requireManagement(actor,ws,project,kind.equals("mock")?"call":"view");
        if(!Set.of("document","mock").contains(kind)&&!requireContent(actor,ws,project).capabilities().contains(Capability.HISTORY_READ))throw error(FORBIDDEN,"forbidden");
    }
    private static boolean allowed(PolicyReadView policy,PolicyReadView.Code code){return ((PolicyReadView.BooleanSetting)policy.settings().stream().filter(s->s.code()==code).findFirst().orElseThrow()).effective();}
    private static ApiException error(org.springframework.http.HttpStatus status,String code){return new ApiException(status,code,"授权操作不满足当前条件");}
    Map<String,Object> view(GrantRepo.Grant grant,String key) {
        var result=new LinkedHashMap<String,Object>();
        result.put("id",String.valueOf(grant.id()));result.put("publicationId",String.valueOf(grant.publication()));result.put("version",grant.version());
        result.put("purpose",grant.purpose());result.put("audience",grant.audience());result.put("responsibleId",String.valueOf(grant.responsible()));
        result.put("responsibilityEpoch",grant.responsibilityEpoch());result.put("generation",grant.generation());result.put("expiresAt",grant.expiresAt());
        result.put("downloadAllowed",grant.downloadAllowed());result.put("revision",grant.revision());result.put("state",grant.state());
        result.put("operationIntent",grant.operationIntent());
        if(grant.publicId()!=null){result.put("publicId",grant.publicId());String origin=publicSettings.getBaseUrl().replaceAll("/$","");result.put(grant.purpose().equals("view")?"publicUrl":"baseUrl",origin+(grant.purpose().equals("view")?"/s/":"/mock/")+grant.publicId());}
        else result.put("memberPath","/api/v1/workspaces/"+grant.workspace()+"/projects/"+grant.project()+"/collaboration/publications/"+grant.publication());
        if(key!=null)result.put("key",key);
        if(grant.reason()!=null)result.put("reason",grant.reason());
        return result;
    }
    private String random(int size){byte[] bytes=new byte[size];random.nextBytes(bytes);return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    static byte[] hash(String key){try{return MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.US_ASCII));}catch(NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
}
