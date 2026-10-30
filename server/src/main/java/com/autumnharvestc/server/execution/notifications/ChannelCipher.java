package com.autumnharvestc.server.execution.notifications;

import com.autumnharvestc.server.execution.ExecutionProperties;
import com.autumnharvestc.server.execution.crypto.DeploymentCipher;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import java.nio.charset.StandardCharsets;
import javax.crypto.Cipher;
import org.springframework.stereotype.Component;

@Component
public class ChannelCipher {
    private final ExecutionProperties properties;private final ObjectMapper json;private final java.security.SecureRandom random=new java.security.SecureRandom();
    public ChannelCipher(ExecutionProperties properties,ObjectMapper json){this.properties=properties;this.json=json;}
    public record Envelope(String keyId,byte[] nonce,byte[] ciphertext){}
    private static byte[] aad(long ws,long channel,long version){return ("notification/v1/"+ws+"/"+channel+"/"+version).getBytes(StandardCharsets.UTF_8);}
    public Envelope seal(long ws,long channel,long version,String url,String secret){
        byte[] plain=null;try{plain=json.writeValueAsBytes(Map.of("url",url,"hmacSecret",secret));byte[] nonce=new byte[12];random.nextBytes(nonce);String key=properties.getMaterials().getKeyId();return new Envelope(key,nonce,new DeploymentCipher(properties).crypt(Cipher.ENCRYPT_MODE,key,nonce,plain,aad(ws,channel,version)));}
        catch(Exception ignored){throw unavailable();}finally{if(plain!=null)Arrays.fill(plain,(byte)0);}
    }
    public DeliveryChannel open(NotificationChannelRepo.Row row){
        byte[] plain=null;try{plain=new DeploymentCipher(properties).crypt(Cipher.DECRYPT_MODE,row.keyId(),row.nonce(),row.ciphertext(),aad(row.workspace(),row.id(),row.version()));var n=json.readTree(plain);return new DeliveryChannel(String.valueOf(row.id()),String.valueOf(row.version()),java.net.URI.create(n.path("url").asText()),n.path("hmacSecret").asText().getBytes(StandardCharsets.UTF_8));}
        catch(Exception ignored){throw unavailable();}finally{if(plain!=null)Arrays.fill(plain,(byte)0);}
    }
    public static com.autumnharvestc.server.core.ApiException unavailable(){return com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,"channel_unavailable","通知渠道部署密钥或密文不可用");}
}
