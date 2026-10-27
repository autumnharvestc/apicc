package com.autumnharvestc.server.execution.materials;

import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.id;
import static com.autumnharvestc.server.execution.agent.AgentRepo.error;
import static com.autumnharvestc.server.execution.materials.ProjectCredentialService.*;

@Service
@Transactional
public class AttachmentService {
    private final JdbcTemplate jdbc;private final AgentService agents;private final ExecutionConfigService configs;
    public AttachmentService(JdbcTemplate jdbc,AgentService agents,ExecutionConfigService configs){this.jdbc=jdbc;this.agents=agents;this.configs=configs;}
    private record File(AttachmentMetadata metadata,byte[] bytes){}
    private List<File> rows(long ws,long project,String ref){return jdbc.query("SELECT * FROM execution_project_attachments WHERE workspace_id=? AND project_id=? AND ref_id=?",(r,n)->new File(new AttachmentMetadata(r.getString("ref_id"),r.getString("version"),r.getString("hash"),r.getLong("size"),r.getString("kind")),r.getBytes("content")),ws,project,ref);}
    public AttachmentMetadata put(UserAccount caller,String ws,String project,AttachmentWrite request){
        agents.requireExecution(caller,ws,project);
        if(request==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","附件必填");validRef(request.refId());
        if(!Set.of("file","network-public").contains(request.kind()==null?"":request.kind()))throw error(HttpStatus.BAD_REQUEST,"sensitive_material_requires_credentials","仅普通文件和公开网络材料可作为附件；私钥及口令请使用项目凭据通路");
        long w=id(ws),p=id(project);var existing=rows(w,p,request.refId());long current=existing.isEmpty()?0:Long.parseLong(existing.getFirst().metadata().version());
        long expected=version(request.expectedVersion());
        boolean expectedAbsent=expected==0&&!existing.isEmpty()&&existing.getFirst().bytes()==null;
        if(expected!=current&&!expectedAbsent)throw error(HttpStatus.CONFLICT,"attachment_version_conflict","附件版本已变化，请重新准备");
        long limit=((Number)configs.policyForProject(w,p).get("singleAttachmentBytes")).longValue();String encoded=request.contentBase64();
        if(encoded==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","附件内容必填");
        if((long)encoded.length()>((limit+2)/3)*4)throw sizeLimit();
        byte[] bytes;
        try{bytes=Base64.getDecoder().decode(encoded);if(!Base64.getEncoder().encodeToString(bytes).equals(encoded))throw new IllegalArgumentException();}
        catch(IllegalArgumentException e){throw error(HttpStatus.BAD_REQUEST,"validation_failed","附件内容必须为标准 Base64");}
        if(bytes.length>limit)throw sizeLimit();
        String hash=hash(bytes);long next=next(current);
        if(jdbc.update("UPDATE execution_project_attachments SET version=?,kind=?,hash=?,size=?,content=? WHERE workspace_id=? AND project_id=? AND ref_id=?",next,request.kind(),hash,bytes.length,bytes,w,p,request.refId())==0)
            jdbc.update("INSERT INTO execution_project_attachments(workspace_id,project_id,ref_id,version,kind,hash,size,content) VALUES(?,?,?,?,?,?,?,?)",w,p,request.refId(),next,request.kind(),hash,bytes.length,bytes);
        return new AttachmentMetadata(request.refId(),String.valueOf(next),hash,bytes.length,request.kind());
    }
    public List<AttachmentMetadata> list(UserAccount caller,String ws,String project){var entity=agents.requireProject(caller,ws,project,false);return jdbc.query("SELECT ref_id,version,hash,size,kind FROM execution_project_attachments WHERE workspace_id=? AND project_id=? AND content IS NOT NULL ORDER BY ref_id",(r,n)->new AttachmentMetadata(r.getString(1),r.getString(2),r.getString(3),r.getLong(4),r.getString(5)),entity.workspaceId(),entity.id());}
    public void remove(UserAccount caller,String ws,String project,String ref,String expected){agents.requireExecution(caller,ws,project);validRef(ref);var file=rows(id(ws),id(project),ref).stream().findFirst().orElseThrow(()->error(HttpStatus.NOT_FOUND,"attachment_missing","附件不存在"));if(version(expected)!=Long.parseLong(file.metadata().version()))throw error(HttpStatus.CONFLICT,"attachment_version_conflict","附件版本已变化");jdbc.update("UPDATE execution_project_attachments SET version=?,content=NULL WHERE workspace_id=? AND project_id=? AND ref_id=?",next(Long.parseLong(file.metadata().version())),id(ws),id(project),ref);}
    /** Requires the caller's current project/task authorization and project lock. */
    public AttachmentValue resolveAuthorized(long ws,long project,AttachmentSelection selected){
        if(selected==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","附件声明必填");validRef(selected.refId());id(selected.version());
        if(selected.hash()==null||!selected.hash().matches("[a-f0-9]{64}"))throw error(HttpStatus.BAD_REQUEST,"validation_failed","附件摘要无效");
        var file=rows(ws,project,selected.refId()).stream().findFirst().orElseThrow(()->error(HttpStatus.CONFLICT,"attachment_missing","附件缺失，请重新准备"));var meta=file.metadata();
        if(file.bytes()==null||!meta.version().equals(selected.version())||!meta.hash().equals(selected.hash()))throw error(HttpStatus.CONFLICT,"attachment_version_conflict","附件已删除或版本/摘要已变化，请重新准备");
        if(file.bytes().length!=meta.size()||!hash(file.bytes()).equals(meta.hash()))throw error(HttpStatus.CONFLICT,"attachment_corrupt","附件摘要或大小不符");
        return new AttachmentValue(meta.refId(),meta.version(),meta.hash(),meta.size(),meta.kind(),Base64.getEncoder().encodeToString(file.bytes()));
    }
    static String hash(byte[] bytes){try{return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));}catch(java.security.NoSuchAlgorithmException e){throw new IllegalStateException(e);}}
    private static com.autumnharvestc.server.core.ApiException sizeLimit(){return error(HttpStatus.BAD_REQUEST,"attachment_size_limit","单附件大小超过当前项目有效额度");}
}
