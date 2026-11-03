package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.access.AccessRequests;
import com.autumnharvestc.server.core.EntityIds;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Set;

/** Finite publication commands; semantic contract selection remains the Core boundary's job. */
final class ArtifactRequests {
    private ArtifactRequests() {}
    sealed interface Source permits Document,Report,Member,Accepted,Mock {}
    record Document(String revision,String manifestHash,JsonNode scope) implements Source {}
    record Report(String jobId) implements Source {}
    record Member(JsonNode artifact) implements Source {}
    record Accepted(String uploadId) implements Source {}
    record Mock(String revision,String manifestHash) implements Source {}
    record Preview(String title,boolean includeEvidence,Source source) {}
    record Confirm(String publicationIntentId,long previewId,String candidateDigest,long expectedPolicyRevision) {}

    static Preview preview(JsonNode body) {
        fields(body,Set.of("title","includeEvidence","source"));
        String title=text(body,"title");var evidence=body.get("includeEvidence");
        if(evidence==null||!evidence.isBoolean())throw invalid();
        var descriptor=body.get("source");if(descriptor==null||!descriptor.isObject())throw invalid();
        String kind=text(descriptor,"kind");Source source;
        if(kind.equals("document")){
            fields(descriptor,Set.of("kind","revision","manifestHash","scope"));
            var scope=descriptor.get("scope");if(scope==null)throw invalid();
            source=new Document(text(descriptor,"revision"),text(descriptor,"manifestHash"),scope.deepCopy());
        }else if(kind.equals("server-report")){
            fields(descriptor,Set.of("kind","jobId"));source=new Report(text(descriptor,"jobId"));
        }else if(kind.equals("member-upload")){
            fields(descriptor,Set.of("kind","artifact"));if(!descriptor.has("artifact"))throw invalid();source=new Member(descriptor.get("artifact").deepCopy());
        }else if(kind.equals("member-history")){
            fields(descriptor,Set.of("kind","uploadId"));source=new Accepted(text(descriptor,"uploadId"));
        }else if(kind.equals("mock")){
            fields(descriptor,Set.of("kind","revision","manifestHash","scope"));var scope=descriptor.get("scope");fields(scope,Set.of("kind"));if(!text(scope,"kind").equals("project"))throw invalid();source=new Mock(text(descriptor,"revision"),text(descriptor,"manifestHash"));
        }else throw invalid();
        return new Preview(title,evidence.booleanValue(),source);
    }
    static Confirm confirm(JsonNode body) {
        fields(body,Set.of("publicationIntentId","previewId","candidateDigest","expectedPolicyRevision"));
        String intent=text(body,"publicationIntentId");if(intent.isBlank())throw invalid();
        long revision=AccessRequests.revision(body.get("expectedPolicyRevision"));if(revision==0)throw invalid();
        return new Confirm(intent,EntityIds.parse(text(body,"previewId")),text(body,"candidateDigest"),revision);
    }
    static void fields(JsonNode value,Set<String> names){
        if(value==null||!value.isObject())throw invalid();
        value.fieldNames().forEachRemaining(name->{if(!names.contains(name))throw invalid();});
    }
    static String text(JsonNode value,String name){var item=value.get(name);if(item==null||!item.isTextual())throw invalid();return item.textValue();}
    static com.autumnharvestc.server.core.ApiException invalid(){return AccessRequests.invalid("发布请求必须使用有限字段及其声明类型");}
}
