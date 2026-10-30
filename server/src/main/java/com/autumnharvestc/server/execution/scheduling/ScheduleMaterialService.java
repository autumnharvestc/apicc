package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.materials.*;
import com.autumnharvestc.server.execution.assets.ExecutionSnapshotService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.stereotype.Service;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;
import static org.springframework.http.HttpStatus.*;

@Service
public class ScheduleMaterialService {
    private final ProjectCredentialService credentials;private final AttachmentService attachments;private final ExecutionConfigService configs;
    private final ScheduleGrantService grants;private final ExecutionSnapshotService snapshots;private final ScheduleNetworkValidator networkValidator;
    public ScheduleMaterialService(ProjectCredentialService credentials,AttachmentService attachments,ExecutionConfigService configs,ScheduleGrantService grants,ExecutionSnapshotService snapshots,ScheduleNetworkValidator networkValidator){this.credentials=credentials;this.attachments=attachments;this.configs=configs;this.grants=grants;this.snapshots=snapshots;this.networkValidator=networkValidator;}
    public Map<String,Object> options(UserAccount caller,String ws,String project){grants.requireRead(caller,ws,project);return Map.of("credentials",credentials.registrations(caller,ws,project),"attachments",attachments.list(caller,ws,project),"credentialValidation","metadata-only");}
    public MaterialSelection seal(UserAccount subject,long ws,long project,ScheduleDtos.Execution execution){
        grants.requireSubject(subject.id(),ws,project);var fixed=snapshots.loadAuthorized(subject,id(execution.snapshotId()));
        if(!fixed.assets().workspaceId().equals(String.valueOf(ws))||!fixed.assets().projectId().equals(String.valueOf(project)))throw error(FORBIDDEN,"snapshot_scope_mismatch","材料封装快照作用域不符");
        var m=execution.materials();if(m==null||!String.valueOf(project).equals(m.projectId())||m.credentials()==null||m.attachments()==null)throw error(BAD_REQUEST,"materials_scope_mismatch","材料必须来自固定项目");
        var policy=configs.policyForProject(ws,project);long limit=((Number)policy.get("totalInputBytes")).longValue(),single=((Number)policy.get("singleAttachmentBytes")).longValue(),total=0;
        for(var file:fixed.assets().files())total=add(total,file.size(),limit);
        var selected=new ArrayList<CredentialSelection>();var refs=new HashSet<String>();
        for(var binding:m.credentials()){
            if(binding==null||!refs.add(binding.refId()))throw error(BAD_REQUEST,"validation_failed","凭据绑定不能重复或为空");
            var registration=credentials.requireRegistrationAuthorized(ws,project,binding.refId(),binding instanceof ScheduleDtos.FixedCredentialBinding f?f.version():null);
            total=add(total,registration.valueBytesUpperBound(),limit);selected.add(registration.selection());
        }
        var mapping=m.attachmentPaths()==null?Map.<String,AttachmentSelection>of():m.attachmentPaths();
        var available=attachments.list(subject,String.valueOf(ws),String.valueOf(project));refs.clear();
        for(var attachment:m.attachments()){
            if(attachment==null||!refs.add(attachment.refId()))throw error(BAD_REQUEST,"validation_failed","附件引用不能重复或为空");id(attachment.version());
            var meta=available.stream().filter(a->a.refId().equals(attachment.refId())).findFirst().orElseThrow(()->error(CONFLICT,"attachment_missing","已上传附件不存在"));
            if(!meta.version().equals(attachment.version())||!meta.hash().equals(attachment.hash()))throw error(CONFLICT,"attachment_version_conflict","附件固定版本或摘要已变化");
            if(meta.size()>single)throw error(BAD_REQUEST,"attachment_size_limit","附件超过当前有效额度");long copies=Math.max(1,mapping.values().stream().filter(attachment::equals).count());for(long i=0;i<copies;i++)total=add(total,meta.size(),limit);
        }
        if(execution.network()!=null){networkValidator.validate(execution.network(),mapping);total=add(total,execution.network().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length,limit);}
        return new MaterialSelection(m.projectId(),List.copyOf(selected),List.copyOf(m.attachments()),mapping);
    }
    private static long add(long current,long bytes,long limit){if(bytes<0||bytes>limit-current)throw error(BAD_REQUEST,"total_input_size_limit","固定快照与登记材料超过当前输入字节额度");return current+bytes;}
}
