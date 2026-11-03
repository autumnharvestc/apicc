package com.autumnharvestc.server.collaboration.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.nio.ByteBuffer;
import com.networknt.schema.*;
import org.springframework.stereotype.Component;

/** The checked-in generated structure boundary is not a substitute for Core semantics. */
@Component
public class RuntimeProtocol {
    private final JsonNode boundary;
    private final JsonSchema request,response,error;
    public RuntimeProtocol(ObjectMapper json) {
        try(var stream=getClass().getResourceAsStream("/collaboration-runtime-boundary.json")){
            if(stream==null)throw new IllegalStateException("Missing generated collaboration boundary");
            boundary=json.readTree(stream);requireLocalReferences(boundary);
            var factory=JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
            var config=SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).build();
            request=factory.getSchema(SchemaLocation.of("urn:apicc:collaboration:request:v1"),boundary.get("request"),config);
            response=factory.getSchema(SchemaLocation.of("urn:apicc:collaboration:response:v1"),boundary.get("response"),config);
            error=factory.getSchema(SchemaLocation.of("urn:apicc:collaboration:error:v1"),boundary.get("error"),config);
        } catch(Exception problem){throw new IllegalStateException("Cannot load generated collaboration boundary",problem);}
    }
    public String coreBuildIdentity(){return boundary.path("coreBuildIdentity").asText();}
    public boolean validRequest(JsonNode value){return value!=null&&request.validate(value).isEmpty();}
    public boolean validResponse(JsonNode value){return value!=null&&response.validate(value).isEmpty();}
    public boolean validError(JsonNode value){return value!=null&&error.validate(value).isEmpty();}
    private static void requireLocalReferences(JsonNode value) {
        if(value.isObject())for(String key:new String[]{"$ref","$dynamicRef","$recursiveRef"})if(value.has(key)&&(!value.get(key).isTextual()||!value.get(key).asText().startsWith("#")))throw new IllegalStateException("Nonlocal generated reference");
        if(value.isContainerNode())value.forEach(RuntimeProtocol::requireLocalReferences);
    }
    /** Exact sha256-json-tree-v1; matches protocol.ts tags/UTF16/f64/ordering. */
    public static String digestJson(JsonNode value) {
        try{var hash=MessageDigest.getInstance("SHA-256");visit(hash,value);return HexFormat.of().formatHex(hash.digest());}
        catch(java.security.NoSuchAlgorithmException problem){throw new IllegalStateException(problem);}
    }
    private static void length(MessageDigest hash,int length){hash.update(ByteBuffer.allocate(4).putInt(length).array());}
    private static void string(MessageDigest hash,String value){
        hash.update((byte)4);length(hash,value.length());var buffer=ByteBuffer.allocate(value.length()*2);
        for(int i=0;i<value.length();i++)buffer.putChar(value.charAt(i));hash.update(buffer.array());
    }
    private static void visit(MessageDigest hash,JsonNode value){
        if(value==null||value.isMissingNode())throw new IllegalArgumentException("RPC_JSON_INVALID");
        if(value.isNull()){hash.update((byte)0);return;}
        if(value.isBoolean()){hash.update((byte)(value.asBoolean()?2:1));return;}
        if(value.isNumber()){
            double number=value.doubleValue();if(!Double.isFinite(number))throw new IllegalArgumentException("RPC_JSON_INVALID");
            hash.update((byte)3);hash.update(ByteBuffer.allocate(8).putDouble(number==0?0:number).array());return;
        }
        if(value.isTextual()){string(hash,value.textValue());return;}
        if(value.isArray()){hash.update((byte)5);length(hash,value.size());value.forEach(child->visit(hash,child));return;}
        if(value.isObject()){
            hash.update((byte)6);length(hash,value.size());var keys=new java.util.ArrayList<String>();value.fieldNames().forEachRemaining(keys::add);keys.sort(String::compareTo);
            for(String key:keys){string(hash,key);visit(hash,value.get(key));}return;
        }
        throw new IllegalArgumentException("RPC_JSON_INVALID");
    }
    /** Count the received UTF8 token span, never Jackson's reserialized spelling. */
    public static int payloadWireBytes(ObjectMapper json,byte[] bytes) {
        try(var parser=json.getFactory().createParser(bytes)){
            if(parser.nextToken()!=com.fasterxml.jackson.core.JsonToken.START_OBJECT)throw new IllegalArgumentException();
            while(parser.nextToken()!=com.fasterxml.jackson.core.JsonToken.END_OBJECT){
                String name=parser.currentName();parser.nextToken();
                if(name.equals("payload")){
                    long start=parser.currentTokenLocation().getByteOffset();parser.skipChildren();
                    return Math.toIntExact(parser.currentLocation().getByteOffset()-start);
                }
                parser.skipChildren();
            }
        }catch(Exception problem){throw new IllegalArgumentException("RPC_RESPONSE_INVALID");}
        throw new IllegalArgumentException("RPC_RESPONSE_INVALID");
    }
}
