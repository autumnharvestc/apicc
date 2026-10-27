package com.autumnharvestc.server.execution.materials;

import com.autumnharvestc.server.execution.ExecutionProperties;
import com.autumnharvestc.server.execution.ExecutionDtos.*;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.store.UserAccount;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.*;
import java.util.*;
import static com.autumnharvestc.server.execution.agent.AgentRepo.*;

@Service
@Transactional
public class ProjectCredentialService {
    private final ProjectCredentialStore store;
    private final AgentService agents;
    private final ExecutionProperties properties;
    private final SecureRandom random=new SecureRandom();
    public ProjectCredentialService(ProjectCredentialStore store,AgentService agents,ExecutionProperties properties){this.store=store;this.agents=agents;this.properties=properties;}
    public CredentialMetadata put(UserAccount caller,String ws,String project,String ref,CredentialWrite request){
        agents.requireExecution(caller,ws,project); validRef(ref);
        if(request==null||request.value()==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","凭据值必填");
        long w=id(ws),p=id(project); var current=store.find(w,p,ref).orElse(null); long version=current==null?0:current.version();
        if(version(request.expectedVersion())!=version)throw conflict();
        long next=next(version); byte[] nonce=new byte[12];random.nextBytes(nonce);
        byte[] plain=request.value().getBytes(StandardCharsets.UTF_8);
        byte[] encrypted;
        try {encrypted=crypt(Cipher.ENCRYPT_MODE,w,p,ref,next,properties.getMaterials().getKeyId(),nonce,plain);}
        finally {Arrays.fill(plain,(byte)0);}
        store.save(new ProjectCredentialStore.Envelope(w,p,ref,next,properties.getMaterials().getKeyId(),nonce,encrypted));
        return new CredentialMetadata(ref,String.valueOf(next),"available");
    }
    public List<CredentialMetadata> list(UserAccount caller,String ws,String project){
        var entity=agents.requireProject(caller,ws,project,false);
        return store.list(entity.workspaceId(),entity.id()).stream().map(row->{
            String status="missing";
            if(row.ciphertext()!=null){try{byte[] value=decrypt(row);Arrays.fill(value,(byte)0);status="available";}catch(com.autumnharvestc.server.core.ApiException e){status="unavailable";}}
            return new CredentialMetadata(row.refId(),String.valueOf(row.version()),status);
        }).toList();
    }
    public void remove(UserAccount caller,String ws,String project,String ref,String expected){
        agents.requireExecution(caller,ws,project);validRef(ref);var row=store.find(id(ws),id(project),ref).orElseThrow(()->missing());
        if(version(expected)!=row.version())throw conflict();
        store.save(new ProjectCredentialStore.Envelope(row.workspaceId(),row.projectId(),ref,next(row.version()),null,null,null));
    }
    /** Internal material seam: caller must hold a currently authorized real project/task lock. */
    public CredentialValue resolveAuthorized(long ws,long project,CredentialSelection selected){
        if(selected==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","凭据引用必填");validRef(selected.refId());
        var row=store.find(ws,project,selected.refId()).orElseThrow(()->missing());
        if(selected.version()!=null&&id(selected.version())!=row.version())throw conflict();
        if(row.ciphertext()==null)throw missing();
        byte[] value=decrypt(row);
        try{return new CredentialValue(row.refId(),String.valueOf(row.version()),new String(value,StandardCharsets.UTF_8));}
        finally{Arrays.fill(value,(byte)0);}
    }
    public void assertVersionsAuthorized(long ws,long project,Map<String,String> versions){
        if(versions==null)throw error(HttpStatus.BAD_REQUEST,"validation_failed","凭据版本清单必填");
        for(var entry:versions.entrySet()){
            id(entry.getValue()); // A start gate requires an actual fixed version, unlike initial local preparation.
            resolveAuthorized(ws,project,new CredentialSelection(entry.getKey(),entry.getValue()));
        }
    }
    private byte[] decrypt(ProjectCredentialStore.Envelope row){return crypt(Cipher.DECRYPT_MODE,row.workspaceId(),row.projectId(),row.refId(),row.version(),row.keyId(),row.nonce(),row.ciphertext());}
    private byte[] crypt(int mode,long ws,long project,String ref,long version,String keyId,byte[] nonce,byte[] content){
        byte[] key=null;
        try{
            var config=properties.getMaterials();
            if(keyId==null||!keyId.matches("[A-Za-z0-9._-]{1,128}")||!keyId.equals(config.getKeyId())||config.getMasterKeyFile()==null||config.getMasterKeyFile().isBlank()||nonce==null||nonce.length!=12)throw new IllegalStateException();
            try(var stream=Files.newInputStream(Path.of(config.getMasterKeyFile()))){key=stream.readNBytes(33);}
            if(key.length!=32)throw new IllegalStateException();
            var cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(mode,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));
            cipher.updateAAD((ws+"\0"+project+"\0"+ref+"\0"+version).getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(content);
        }catch(Exception ignored){throw error(HttpStatus.SERVICE_UNAVAILABLE,"credential_unavailable","项目凭据密钥缺失、不可用或密文损坏，请检查部署密钥");}
        finally{if(key!=null)Arrays.fill(key,(byte)0);}
    }
    static void validRef(String ref){if(ref==null||!ref.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,255}"))throw error(HttpStatus.BAD_REQUEST,"validation_failed","材料引用格式无效");}
    static long version(String value){if(value==null||!value.matches("0|[1-9][0-9]*"))throw error(HttpStatus.BAD_REQUEST,"validation_failed","expectedVersion 必须为版本字符串");try{return Long.parseLong(value);}catch(NumberFormatException e){throw error(HttpStatus.BAD_REQUEST,"validation_failed","版本超出范围");}}
    static long next(long value){if(value==Long.MAX_VALUE)throw error(HttpStatus.CONFLICT,"version_exhausted","材料版本已达到上限");return value+1;}
    private static com.autumnharvestc.server.core.ApiException conflict(){return error(HttpStatus.CONFLICT,"credential_version_conflict","凭据版本已变化，请重新准备");}
    private static com.autumnharvestc.server.core.ApiException missing(){return error(HttpStatus.CONFLICT,"credential_missing","项目凭据缺失；不会回退同名本机凭据或无认证发送");}
}
