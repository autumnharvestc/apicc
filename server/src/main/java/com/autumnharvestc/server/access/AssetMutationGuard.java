package com.autumnharvestc.server.access;

import com.autumnharvestc.server.collaboration.runtime.*;
import com.autumnharvestc.server.core.*;
import com.autumnharvestc.server.execution.ExecutionDtos.AssetFile;
import com.autumnharvestc.server.execution.agent.AgentRepo;
import com.autumnharvestc.server.execution.assets.ProjectAssetsService;
import com.autumnharvestc.server.store.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.*;
import java.util.function.Supplier;

/** Full fixed project snapshots go to pure Core; Java alone admits and commits writes. */
@Service
public class AssetMutationGuard {
    private final ProjectAccessService access;
    private final CollaborationRuntimeClient runtime;
    private final RuntimeProperties properties;
    private final ObjectMapper json;
    private final FileVersionRepo files;
    private final AgentRepo audit;
    private final TransactionTemplate transactions;
    public AssetMutationGuard(ProjectAccessService access,CollaborationRuntimeClient runtime,RuntimeProperties properties,ObjectMapper json,FileVersionRepo files,AgentRepo audit,PlatformTransactionManager transactions) {
        this.access=access;this.runtime=runtime;this.properties=properties;this.json=json;this.files=files;this.audit=audit;this.transactions=new TransactionTemplate(transactions);
    }
    public record Classification(String summary,List<String> locations) {}
    /** Called only after acquiring the existing project commit lock, never while waiting for it/RPC. */
    public void requireCommit(UserAccount caller,long ws,long project,Classification classification) {
        var current=access.resolve(caller.id(),ws,project);
        if(current.effectiveRole().isEmpty()||current.effectiveRole().get()==Role.VIEWER)throw denied("当前账号、成员或项目编辑权限已失效");
        if(!classification.summary().equals("script-unchanged")&&!current.capabilities().contains(Capability.SCRIPT_EDIT))throw denied("当前脚本编辑权限已失效，无法提交本次资产变更");
    }
    public Classification classify(UserAccount caller,long ws,long project,JsonNode beforeFiles,JsonNode afterFiles,List<String> changedPaths) {
        return classify(caller,ws,project,beforeFiles,afterFiles,changedPaths,null);
    }
    public Classification classify(UserAccount caller,long ws,long project,JsonNode beforeFiles,JsonNode afterFiles,List<String> changedPaths,String initialContractProjectId) {
        boolean scripts=access.resolve(caller.id(),ws,project).capabilities().contains(Capability.SCRIPT_EDIT);
        if(!properties.isEnabled()) {
            if(!scripts)throw denied("脚本分类服务未启用，无法确认本次资产变更不含脚本");
            return new Classification("classification-disabled",List.copyOf(changedPaths));
        }
        var payload=json.createObjectNode();payload.set("beforeFiles",beforeFiles);payload.set("afterFiles",afterFiles);
        if(initialContractProjectId!=null)payload.put("initialContractProjectId",initialContractProjectId);
        try {
            var result=runtime.call("classify-asset-mutation",payload,System.currentTimeMillis()+10_000,1_048_576);
            boolean changed=result.path("scriptChanged").booleanValue();
            if(changed&&!scripts)throw denied("本次变更修改或删除脚本，需要业务权限：script.edit");
            var locations=new ArrayList<String>();result.path("locations").forEach(location->locations.add(location.textValue()));
            return new Classification(changed?"script-changed":"script-unchanged",List.copyOf(locations));
        } catch(CollaborationRuntimeClient.Failure failure) {
            if(initialContractProjectId!=null&&"PUBLICATION_SOURCE_INVALID".equals(failure.code()))
                throw new ApiException(HttpStatus.BAD_REQUEST,"invalid_project_assets","首次保存需要完整、有效的项目资产");
            if(!scripts)throw denied("脚本分类不可用或项目布局无法解析，无法确认本次变更不含脚本");
            return new Classification("classification-unavailable",List.copyOf(changedPaths));
        }
    }
    public JsonNode wireFiles(List<AssetFile> entries) {
        var result=json.createArrayNode();entries.stream().sorted(Comparator.comparing(AssetFile::path)).forEach(file->result.addObject().put("path",file.path()).put("content",file.content()));return result;
    }
    public JsonNode changedFiles(JsonNode before,Map<String,String> changes,Collection<String> deletes) {
        var values=new TreeMap<String,String>();before.forEach(file->values.put(file.path("path").asText(),file.path("content").isNull()?null:file.path("content").asText()));values.putAll(changes);deletes.forEach(values::remove);
        var result=json.createArrayNode();values.forEach((path,content)->result.addObject().put("path",path).put("content",content));return result;
    }
    private record Snapshot(List<AssetFile> files,String manifest) {}
    private Snapshot snapshot(long ws,long project) {
        String prefix=project+"/";
        var entries=files.listByProject(ws,project).stream().map(row->new AssetFile(row.path().substring(prefix.length()),row.content(),String.valueOf(row.version()),row.contentHash(),row.contentSize())).toList();
        return new Snapshot(entries,ProjectAssetsService.manifestHash(entries));
    }
    private void lock(long ws,long project) {
        if(!files.lockProject(ws,project))throw new ApiException(HttpStatus.NOT_FOUND,"project_not_found","项目已删除，不能写入文件");
    }
    /** Each legacy batch item owns its complete read/classify/commit cycle and transaction. */
    public <T>T legacy(UserAccount caller,long ws,long project,String path,String content,long version,Supplier<T> mutation) {
        var before=transactions.execute(tx->{lock(ws,project);return snapshot(ws,project);});
        var oldFiles=wireFiles(before.files());
        Map<String,String> changes=new HashMap<>();if(content!=null)changes.put(path,content);
        var classification=classify(caller,ws,project,oldFiles,changedFiles(oldFiles,changes,content==null?List.of(path):List.of()),List.of(path));
        return transactions.execute(tx->{
            lock(ws,project);requireCommit(caller,ws,project,classification);
            if(!snapshot(ws,project).manifest().equals(before.manifest())) {
                var current=files.find(ws,project+"/"+path);
                throw new VersionConflictException(current.map(FileVersionRecord::version).orElse(0L),current.map(FileVersionRecord::contentHash).orElse(null));
            }
            T result=mutation.get();var after=snapshot(ws,project);audit(caller,project,version,classification,before.manifest(),after.manifest());return result;
        });
    }
    public void audit(UserAccount caller,long project,long version,Classification classification,String before,String after) {
        try {audit.auditAssets(caller.id(),project,version,classification.summary(),json.writeValueAsString(classification.locations()),before,after);}
        catch(com.fasterxml.jackson.core.JsonProcessingException failure){throw new IllegalStateException("Cannot encode asset business locations",failure);}
    }
    private static ApiException denied(String message){return new ApiException(HttpStatus.FORBIDDEN,"forbidden",message);}
}
