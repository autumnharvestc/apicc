package com.autumnharvestc.server.execution.materials;

import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.agent.AgentPrincipal;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.assets.ExecutionSnapshotService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class ExecutionMaterialsService {
    private final ExecutionSnapshotService snapshots;private final AgentService agents;private final ProjectCredentialService credentials;private final AttachmentService attachments;private final ExecutionConfigService configs;private final ObjectProvider<AssignedMaterialAuthorizer> assignments;
    public ExecutionMaterialsService(ExecutionSnapshotService snapshots,AgentService agents,ProjectCredentialService credentials,AttachmentService attachments,ExecutionConfigService configs,ObjectProvider<AssignedMaterialAuthorizer> assignments){this.snapshots=snapshots;this.agents=agents;this.credentials=credentials;this.attachments=attachments;this.configs=configs;this.assignments=assignments;}
    public ProjectRunMaterials local(UserAccount caller,String snapshot,MaterialSelection selection){
        var fixed=snapshots.loadAuthorized(caller,id(snapshot));
        agents.requireExecution(caller,fixed.assets().workspaceId(),fixed.assets().projectId());
        return resolve(fixed,selection,null);
    }
    public ProjectRunMaterials agent(AgentPrincipal agent,String job,AgentMaterialRequest request){
        if(agent==null)throw error(HttpStatus.UNAUTHORIZED,"unauthorized","需要有效代理身份");
        if(request==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","executionId 必填");
        long jobId=id(job),executionId=id(request.executionId());
        var authorization=assignments.getIfAvailable();
        if(authorization==null)throw error(HttpStatus.FORBIDDEN,"assignment_required","任务材料未获当前代理的权威执行分配授权");
        var authorized=authorization.requireAssigned(agent.agentId(),jobId,executionId);
        if(authorized==null||authorized.snapshot()==null||authorized.selection()==null)throw error(HttpStatus.FORBIDDEN,"assignment_required","任务材料分配不可用");
        return resolve(authorized.snapshot(),authorized.selection(),agent.agentId());
    }
    @SuppressWarnings("unchecked")
    private ProjectRunMaterials resolve(ExecutionSnapshot fixed,MaterialSelection selection,Long agent){
        var scope=fixed.assets();
        if(selection==null||selection.credentials()==null||selection.attachments()==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","材料选择清单必填");
        id(selection.projectId());
        if(!scope.projectId().equals(selection.projectId()))throw error(HttpStatus.FORBIDDEN,"materials_scope_mismatch","运行材料必须属于权威快照对应项目");
        var policy=(Map<String,Object>)configs.effective(agent,id(scope.workspaceId()),id(scope.projectId()),Map.of()).get("policy");
        long totalLimit=((Number)policy.get("totalInputBytes")).longValue();long singleLimit=((Number)policy.get("singleAttachmentBytes")).longValue();
        long total=0;
        for(var file:scope.files())total=addBytes(total,file.size(),totalLimit);
        var credentialValues=new ArrayList<CredentialValue>();var refs=new HashSet<String>();
        for(var ref:selection.credentials()){
            if(ref==null||!refs.add(ref.refId()))throw error(HttpStatus.BAD_REQUEST,"validation_failed","凭据引用不能重复或为空");
            var value=credentials.resolveAuthorized(id(scope.workspaceId()),id(scope.projectId()),ref);
            total=addBytes(total,value.value().getBytes(StandardCharsets.UTF_8).length,totalLimit);credentialValues.add(value);
        }
        var attachmentValues=new ArrayList<AttachmentValue>();refs.clear();
        for(var ref:selection.attachments()){
            if(ref==null||!refs.add(ref.refId()))throw error(HttpStatus.BAD_REQUEST,"validation_failed","附件引用不能重复或为空");
            var value=attachments.resolveAuthorized(id(scope.workspaceId()),id(scope.projectId()),ref);
            if(value.size()>singleLimit)throw error(HttpStatus.BAD_REQUEST,"attachment_size_limit","单附件超过当前项目有效额度");
            total=addBytes(total,value.size(),totalLimit);attachmentValues.add(value);
        }
        return new ProjectRunMaterials(fixed.snapshotId(),new MaterialScope(scope.workspaceId(),scope.groupId(),scope.projectId()),List.copyOf(credentialValues),List.copyOf(attachmentValues));
    }
    private static long addBytes(long total,long bytes,long limit){if(bytes<0||bytes>limit-total)throw error(HttpStatus.BAD_REQUEST,"total_input_size_limit","快照和本任务材料总大小超过当前项目有效额度");return total+bytes;}
}
