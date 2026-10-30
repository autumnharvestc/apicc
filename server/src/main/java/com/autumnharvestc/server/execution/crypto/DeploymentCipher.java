package com.autumnharvestc.server.execution.crypto;

import com.autumnharvestc.server.execution.ExecutionProperties;
import java.nio.file.*;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.*;

/** Deployment AES-GCM primitive. Business domains supply their own exact AAD bytes. */
public final class DeploymentCipher {
    private final ExecutionProperties properties;
    public DeploymentCipher(ExecutionProperties properties){this.properties=properties;}
    public static final class Unavailable extends RuntimeException {public Unavailable(){super("Deployment cipher unavailable",null,false,false);}}
    public byte[] crypt(int mode,String keyId,byte[] nonce,byte[] content,byte[] aad){
        byte[] key=null;
        try{
            var config=properties.getMaterials();
            if(keyId==null||!keyId.matches("[A-Za-z0-9._-]{1,128}")||!keyId.equals(config.getKeyId())||config.getMasterKeyFile()==null||config.getMasterKeyFile().isBlank()||nonce==null||nonce.length!=12)throw new IllegalStateException();
            try(var stream=Files.newInputStream(Path.of(config.getMasterKeyFile()))){key=stream.readNBytes(33);}
            if(key.length!=32)throw new IllegalStateException();
            var cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(mode,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(aad);return cipher.doFinal(content);
        }catch(Exception ignored){throw new Unavailable();}
        finally{if(key!=null)Arrays.fill(key,(byte)0);}
    }
}
