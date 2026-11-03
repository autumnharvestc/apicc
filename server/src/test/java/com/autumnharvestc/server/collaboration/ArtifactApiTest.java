package com.autumnharvestc.server.collaboration;

import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.Hashes;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import java.util.*;
import static org.assertj.core.api.Assertions.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ArtifactApiTest extends ArtifactHttpFixture {
    void rejects(String code,Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,error->assertThat(error.getCode()).isEqualTo(code));
    }
    void reportControl(Fixture f) {
        var fixed=sources.report(f.owner().account(),f.workspace(),f.project(),f.job(),SOURCE_LIMIT);
        assertThat(fixed.workspace()).isEqualTo(Long.parseLong(f.workspace()));
        assertThat(fixed.project()).isEqualTo(Long.parseLong(f.project()));
        assertThat(fixed.execution()).isEqualTo(Long.parseLong(f.execution()));
        assertThat(fixed.state()).isEqualTo("ended");assertThat(fixed.reportState()).isEqualTo("archived");
        assertThat(fixed.hash()).isEqualTo(Hashes.sha256Hex(f.report()));assertThat(fixed.length()).isEqualTo((long)f.report().length);
        assertThat(Arrays.equals(fixed.body(),f.report())).as("complete actual archive bytes").isTrue();
    }
    @Test void sameProjectSourcesAreRealAndReachable()throws Exception {
        var f=fixture();
        var document=sources.document(f.owner().account(),f.workspace(),f.project(),"1",f.assets().path("manifestHash").asText(),SOURCE_LIMIT);
        assertThat(document.version()).isEqualTo("1");assertThat(document.manifestHash()).isEqualTo(f.assets().path("manifestHash").asText());
        assertThat(document.files()).hasSize(f.assets().path("files").size());
        for(var file:document.files()) {
            assertThat(file.hash()).isEqualTo(Hashes.sha256HexUtf8(file.content()));
            var stored=java.util.stream.StreamSupport.stream(f.assets().path("files").spliterator(),false).filter(row->row.path("path").asText().equals(file.path())).findFirst().orElseThrow();
            assertThat(file.content().equals(stored.path("content").asText())).as("fixed original file bytes").isTrue();
        }
        reportControl(f);
    }
    // Break: resolving the latest saved files instead of refusing a stale preview identity.
    @Test void changedDocumentRevisionRequiresNewPreview()throws Exception {
        var f=fixture();String digest=f.assets().path("manifestHash").asText();
        assertThat(sources.document(f.owner().account(),f.workspace(),f.project(),"1",digest,SOURCE_LIMIT).version()).isEqualTo("1");
        save(f.owner(),f.workspace(),f.project(),"1",List.of(Map.of("path","notes.md","content","later source edit")));
        rejects("source_revision_conflict",()->sources.document(f.owner().account(),f.workspace(),f.project(),"1",digest,SOURCE_LIMIT));
    }
    // Break: using management rights on one project as permission to publish another project's report.
    @Test void reportCannotCrossProjectScope()throws Exception {
        var f=fixture();reportControl(f);
        rejects("source_scope_mismatch",()->sources.report(f.owner().account(),f.workspace(),f.other(),f.job(),SOURCE_LIMIT));
    }
    @ParameterizedTest @CsvSource({"pending,source_report_pending","expired,source_report_expired"})
    void reportStateRejectsUnavailableSource(String state,String code)throws Exception {
        var f=fixture();reportControl(f);jdbc.update("UPDATE execution_jobs SET report_state=? WHERE id=?",state,Long.valueOf(f.job()));
        rejects(code,()->sources.report(f.owner().account(),f.workspace(),f.project(),f.job(),SOURCE_LIMIT));
    }
    @Test void archivedReportRequiresBody()throws Exception {
        var f=fixture();reportControl(f);jdbc.update("UPDATE execution_jobs SET report_content=NULL WHERE id=?",Long.valueOf(f.job()));
        rejects("source_report_missing",()->sources.report(f.owner().account(),f.workspace(),f.project(),f.job(),SOURCE_LIMIT));
    }
    @Test void archivedReportRequiresActualHash()throws Exception {
        var f=fixture();reportControl(f);var changed=json.readTree(f.report());((com.fasterxml.jackson.databind.node.ObjectNode)changed).put("collectionName","Different report");
        jdbc.update("UPDATE execution_jobs SET report_content=? WHERE id=?",json.writeValueAsBytes(changed),Long.valueOf(f.job()));
        rejects("source_digest_mismatch",()->sources.report(f.owner().account(),f.workspace(),f.project(),f.job(),SOURCE_LIMIT));
    }
    @Test void archivedReportRequiresActualLength()throws Exception {
        var f=fixture();reportControl(f);jdbc.update("UPDATE execution_jobs SET report_bytes=report_bytes+1 WHERE id=?",Long.valueOf(f.job()));
        rejects("source_length_mismatch",()->sources.report(f.owner().account(),f.workspace(),f.project(),f.job(),SOURCE_LIMIT));
    }
    @Test void archivedReportRequiresTerminalState()throws Exception {
        var f=fixture();reportControl(f);jdbc.update("UPDATE execution_jobs SET state='running' WHERE id=?",Long.valueOf(f.job()));
        rejects("source_report_pending",()->sources.report(f.owner().account(),f.workspace(),f.project(),f.job(),SOURCE_LIMIT));
    }
    // Break: accepting a different expected manifest merely because the numeric version matches.
    @Test void sameRevisionDocumentRequiresExpectedManifest()throws Exception {
        var f=fixture();String digest=f.assets().path("manifestHash").asText();
        assertThat(sources.document(f.owner().account(),f.workspace(),f.project(),"1",digest,SOURCE_LIMIT).manifestHash()).isEqualTo(digest);
        String different=digest.equals("0".repeat(64))?"1".repeat(64):"0".repeat(64);
        rejects("source_digest_mismatch",()->sources.document(f.owner().account(),f.workspace(),f.project(),"1",different,SOURCE_LIMIT));
    }
    // Break: measuring characters instead of total actual source UTF8 bytes, or silently accepting overage.
    @Test void documentSourceRejectsActualUtf8ByteOverage()throws Exception {
        var f=fixture();int limit=1_048_576;
        long original=0;for(var file:f.assets().path("files"))original+=file.path("size").asLong();
        String padding="雪"+"x".repeat(Math.toIntExact(limit-original-3));
        var exact=save(f.owner(),f.workspace(),f.project(),"1",List.of(Map.of("path","notes.md","content",padding)));
        var fixed=sources.document(f.owner().account(),f.workspace(),f.project(),"2",exact.path("manifestHash").asText(),limit);
        assertThat(fixed.files().stream().mapToLong(file->file.size()).sum()).isEqualTo(limit);
        assertThat(fixed.files().stream().filter(file->file.path().equals("notes.md")).findFirst().orElseThrow().content().equals(padding)).as("entire exact-limit UTF8 source").isTrue();
        var over=save(f.owner(),f.workspace(),f.project(),"2",List.of(Map.of("path","notes.md","content",padding+"x")));
        rejects("source_size_limit",()->sources.document(f.owner().account(),f.workspace(),f.project(),"3",over.path("manifestHash").asText(),limit));
    }
    // Break: reading/accepting the entire archived body above the legal source limit.
    @Test void reportSourceRejectsActualByteOverage()throws Exception {
        int limit=1_048_576;var exact=fixture(limit);reportControl(exact);
        assertThat(sources.report(exact.owner().account(),exact.workspace(),exact.project(),exact.job(),limit).body().length).isEqualTo(limit);
        var over=fixture(limit+1);reportControl(over);
        rejects("source_size_limit",()->sources.report(over.owner().account(),over.workspace(),over.project(),over.job(),limit));
    }
    void confirmReject(Fixture f,Actor actor,String target,com.fasterxml.jackson.databind.JsonNode input,int status,String code)throws Exception{
        long count=publicationCount(f);var response=request(actor.token(),post(target+"/publications"),input).andReturn().getResponse();var result=json.readTree(response.getContentAsByteArray());
        assertAll(()->assertEquals(status,response.getStatus(),"confirm status"),()->assertEquals(code,result.path("code").asText("missing")),()->assertEquals(count,publicationCount(f),"no publication written"));
    }
    void previewReject(Fixture f,Actor actor,com.fasterxml.jackson.databind.JsonNode input,int status,String code)throws Exception{
        long count=previewCount(f);var response=request(actor.token(),post(collaboration(f)+"/previews"),input).andReturn().getResponse();var result=json.readTree(response.getContentAsByteArray());
        assertAll(()->assertEquals(status,response.getStatus(),"preview status"),()->assertEquals(code,result.path("code").asText("missing")),()->assertEquals(count,previewCount(f),"no candidate written"));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(booleans={true,false})
    void publicationRealSourcesAndStoredBytes(boolean document)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),document?documentRequest(f):reportRequest(f));assertEquals(1,rpc.requests.size());var input=rpc.requests.getFirst().at("/payload/input");
        if(document){assertEquals("saved-contract",input.path("sourceKind").asText());assertEquals(f.assets().path("manifestHash").asText(),input.at("/source/digest").asText());assertEquals(f.assets().path("files").size(),input.path("files").size());
            for(var file:f.assets().path("files")){var sent=java.util.stream.StreamSupport.stream(input.path("files").spliterator(),false).filter(item->item.path("path").asText().equals(file.path("path").asText())).findFirst().orElseThrow();assertTrue(file.path("content").equals(sent.path("content")),"RPC carries exact locked source text");}}
        else{assertEquals("server-archive",input.path("sourceKind").asText());assertEquals("unavailable",input.path("redaction").asText());assertEquals(f.execution(),input.at("/source/revision").asText());assertTrue(json.readTree(f.report()).equals(input.at("/report/body")),"actual archived bytes, not renderer content");}
        assertEquals(1,candidate.path("expectedPolicyRevision").asLong(-1));String intent=UUID.randomUUID().toString();var published=publish(f,candidate,intent);var read=publication(f,f.viewer(),published.path("id").asText());
        byte[] expectedBody=json.writeValueAsBytes(candidate.path("artifact"));byte[] stored=jdbc.queryForObject("SELECT body FROM collaboration_publications WHERE id=?",byte[].class,Long.parseLong(published.path("id").asText()));
        assertAll(()->assertTrue(Arrays.equals(expectedBody,stored),"exact server candidate bytes in storage"),()->assertEquals(Hashes.sha256Hex(expectedBody),published.path("digest").asText()),
            ()->assertTrue(candidate.path("artifact").equals(read.path("artifact")),"exact candidate bytes read back"),()->assertEquals(candidate.path("candidateDigest").asText(),read.path("digest").asText()),()->assertEquals(1,publicationCount(f)),()->assertEquals(1,rpc.requests.size(),"confirm/read never reproject"));
        var operation=body(mvc.perform(get(collaboration(f)+"/operations/"+intent).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));assertEquals(published.path("id").asText(),operation.path("publicationId").asText());assertFalse(operation.has("artifact"));
    }
    @Test void publicationEditorWithExplicitPurposeDoesNotNeedPolicyManagerRole()throws Exception {
        var f=fixture();capability(f,f.editor(),"publication.manage","allow");var candidate=preview(f,f.editor(),documentRequest(f));
        request(f.editor().token(),post(collaboration(f)+"/publications"),confirmation(candidate,UUID.randomUUID().toString())).andExpect(status().isCreated());assertEquals(1,publicationCount(f));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"viewer","editor","owner-deny-document","owner-deny-report"})
    void publicationPreviewRequiresItsNewPurpose(String branch)throws Exception {
        var f=fixture();preview(f,f.owner(),documentRequest(f));Actor actor=branch.equals("viewer")?f.viewer():branch.equals("editor")?f.editor():f.owner();
        if(branch.startsWith("owner-deny"))capability(f,f.owner(),"publication.manage","deny");previewReject(f,actor,branch.endsWith("report")?reportRequest(f):documentRequest(f),403,"forbidden");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"unknown-top","actor","already-redacted","unknown-source","kind","title-type","evidence-type","missing-title","missing-source","root-array"})
    void publicationPreviewUsesStrictFiniteInput(String branch)throws Exception {
        var f=fixture();preview(f,f.owner(),documentRequest(f));var input=documentRequest(f);com.fasterxml.jackson.databind.JsonNode changed=input;
        switch(branch){case "unknown-top"->input.put("unknown",true);case "actor"->input.put("agentId",f.execution());case "already-redacted"->input.put("alreadyRedacted",true);case "unknown-source"->((com.fasterxml.jackson.databind.node.ObjectNode)input.path("source")).put("creator",f.owner().id());
            case "kind"->((com.fasterxml.jackson.databind.node.ObjectNode)input.path("source")).put("kind","server-archive");case "title-type"->input.put("title",42);case "evidence-type"->input.put("includeEvidence","false");case "missing-title"->input.remove("title");case "missing-source"->input.remove("source");case "root-array"->changed=json.createArrayNode();}
        previewReject(f,f.owner(),changed,400,"validation_failed");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"replacement","unknown","actor","missing-intent","blank-intent","intent-type","missing-preview","missing-digest","missing-policy","numeric-preview","text-policy","fraction-policy","zero-policy","unsafe-policy","long-policy"})
    void publicationConfirmationUsesStrictFields(String branch)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));var input=confirmation(candidate,UUID.randomUUID().toString());
        switch(branch){case "replacement"->input.set("artifact",candidate.path("artifact"));case "unknown"->input.put("intentId","not-the-contract-field");case "actor"->input.put("creator",f.owner().id());case "missing-intent"->input.remove("publicationIntentId");case "missing-preview"->input.remove("previewId");case "missing-digest"->input.remove("candidateDigest");case "missing-policy"->input.remove("expectedPolicyRevision");
            case "blank-intent"->input.put("publicationIntentId","");case "intent-type"->input.put("publicationIntentId",42);case "numeric-preview"->input.put("previewId",Long.parseLong(candidate.path("id").asText()));case "text-policy"->input.put("expectedPolicyRevision","1");case "fraction-policy"->input.put("expectedPolicyRevision",1.5);case "zero-policy"->input.put("expectedPolicyRevision",0);case "unsafe-policy"->input.put("expectedPolicyRevision",9007199254740992L);case "long-policy"->input.put("expectedPolicyRevision",new java.math.BigInteger("9223372036854775808"));}
        confirmReject(f,f.owner(),collaboration(f),input,400,"validation_failed");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"digest","epoch","actor","project","cancelled","consumed","stored-body"})
    void publicationCandidateBindingIsRechecked(String branch)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));var input=confirmation(candidate,UUID.randomUUID().toString());Actor actor=f.owner();String target=collaboration(f),code="candidate_digest_mismatch";int expected=409;
        switch(branch){case "digest"->input.put("candidateDigest","b".repeat(64));case "epoch"->{input.put("expectedPolicyRevision",2);code="publication_policy_changed";}case "actor"->{capability(f,f.editor(),"publication.manage","allow");actor=f.editor();code="preview_actor_mismatch";expected=403;}
            case "project"->{target="/api/v1/workspaces/"+f.workspace()+"/projects/"+f.other()+"/collaboration";mvc.perform(get(f.url().replace("/projects/"+f.project(),"/projects/"+f.other())+"/assets").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());code="preview_not_found";expected=404;}
            case "cancelled"->{request(f.owner().token(),delete(target+"/previews/"+candidate.path("id").asText()),Map.of()).andExpect(status().isNoContent());code="preview_not_pending";}
            case "consumed"->{publish(f,candidate,UUID.randomUUID().toString());code="preview_not_pending";}
            case "stored-body"->{var modified=(com.fasterxml.jackson.databind.node.ObjectNode)candidate.path("artifact").deepCopy();modified.put("title","Changed stored candidate");jdbc.update("UPDATE collaboration_previews SET body=? WHERE id=?",json.writeValueAsBytes(modified),Long.parseLong(candidate.path("id").asText()));}}
        confirmReject(f,actor,target,input,expected,code);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"document","report-changed","report-expired"})
    void publicationCurrentSourceCannotBeReplaced(String branch)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),branch.equals("document")?documentRequest(f):reportRequest(f));String reason="publication_source_changed";int expected=409;
        if(branch.equals("document")){save(f.owner(),f.workspace(),f.project(),"1",List.of(Map.of("path","notes.md","content","New saved revision")));reason="source_revision_conflict";}
        else if(branch.equals("report-expired")){jdbc.update("UPDATE execution_jobs SET report_state='expired',report_content=NULL WHERE id=?",Long.parseLong(f.job()));reason="source_report_expired";expected=410;}
        else{var report=(com.fasterxml.jackson.databind.node.ObjectNode)json.readTree(f.report());report.put("collectionName","Changed archived source");byte[] body=json.writeValueAsBytes(report);jdbc.update("UPDATE execution_jobs SET report_content=?,report_hash=?,report_bytes=? WHERE id=?",body,Hashes.sha256Hex(body),body.length,Long.parseLong(f.job()));}
        confirmReject(f,f.owner(),collaboration(f),confirmation(candidate,UUID.randomUUID().toString()),expected,reason);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"purpose-denied","history-denied","restored","project-policy","ancestor-policy","ancestor-restored"})
    void publicationCurrentAccessAndWholePolicyAreBound(String branch)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),reportRequest(f));String code="publication_policy_changed";int expected=409;
        switch(branch){case "purpose-denied"->{capability(f,f.owner(),"publication.manage","deny");code="forbidden";expected=403;}case "history-denied"->{capability(f,f.owner(),"history.read","deny");code="forbidden";expected=403;}
            case "restored"->{capability(f,f.owner(),"publication.manage","deny");capability(f,f.owner(),"publication.manage","inherit");code="publication_access_changed";}
            case "project-policy"->policy(f,false,Map.of("maxProjectVersions",900));case "ancestor-policy"->policy(f,true,Map.of("maxProjectVersions",900));case "ancestor-restored"->{policy(f,true,Map.of("maxProjectVersions",900));var clear=new LinkedHashMap<String,Object>();clear.put("maxProjectVersions",null);policy(f,true,clear);}}
        confirmReject(f,f.owner(),collaboration(f),confirmation(candidate,UUID.randomUUID().toString()),expected,code);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"history-disabled","evidence"})
    void publicationCurrentFeatureRequiresExplicitAllowance(String branch)throws Exception {
        var f=fixture();preview(f,f.owner(),reportRequest(f));var input=reportRequest(f);String code="publication_evidence_not_allowed";
        if(branch.equals("history-disabled")){policy(f,false,Map.of("historyPublishingAllowed",false));code="publication_policy_disabled";}else input.put("includeEvidence",true);
        previewReject(f,f.owner(),input,403,code);
    }
    @Test void publicationSameIntentReturnsOriginalAndOneVersion()throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));String intent=UUID.randomUUID().toString();var first=publish(f,candidate,intent);
        var response=request(f.owner().token(),post(collaboration(f)+"/publications"),confirmation(candidate,intent)).andReturn().getResponse();var replay=json.readTree(response.getContentAsByteArray());
        var list=body(mvc.perform(get(collaboration(f)+"/publications").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk()));
        assertAll(()->assertEquals(200,response.getStatus()),()->assertEquals(first.path("id").asText(),replay.path("id").asText()),()->assertEquals(first.path("digest").asText(),replay.path("digest").asText()),()->assertEquals(1,list.path("items").size()),()->assertEquals(1,publicationCount(f)));
    }
    @Test void publicationChangedCandidateCannotReuseIntent()throws Exception {
        var f=fixture();var first=preview(f,f.owner(),documentRequest(f));String intent=UUID.randomUUID().toString();publish(f,first,intent);var changed=documentRequest(f).put("title","A different explicit candidate");var next=preview(f,f.owner(),changed);
        assertNotEquals(first.path("candidateDigest"),next.path("candidateDigest"));confirmReject(f,f.owner(),collaboration(f),confirmation(next,intent),409,"publication_intent_conflict");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(longs={600000,600001})
    void publicationExpiredPreviewCannotBeConfirmed(long elapsed)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));artifactTime.advance(elapsed);confirmReject(f,f.owner(),collaboration(f),confirmation(candidate,UUID.randomUUID().toString()),410,"preview_expired");
    }
    @Test void publicationHumanConfirmationHasItsOwnOperationBudget()throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));artifactTime.advance(300000);publish(f,candidate,UUID.randomUUID().toString());assertEquals(1,publicationCount(f));
    }
    @Test void publicationGenerationCannotResetDeadlineAfterRpc()throws Exception {
        var f=fixture();preview(f,f.owner(),documentRequest(f));rpc.responseAction=()->artifactTime.advance(60001);previewReject(f,f.owner(),documentRequest(f),408,"publication_deadline_exceeded");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"get-preview","delete-preview","get-operation","publication-history","publication-project","preview-project","publication-nonmember","operation-project","preview-unknown","publication-unknown","operation-unknown"})
    void publicationReadRoutesHaveIndependentCurrentAuthority(String branch)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),branch.equals("publication-history")?reportRequest(f):documentRequest(f));String intent=UUID.randomUUID().toString();var published=publish(f,candidate,intent);String target=collaboration(f),suffix="/previews/"+candidate.path("id").asText(),reason="forbidden";int expected=403;Actor actor=f.viewer();
        if(branch.equals("get-operation"))suffix="/operations/"+intent;
        if(branch.equals("publication-nonmember")){actor=actor();suffix="/publications/"+published.path("id").asText();}
        if(branch.equals("operation-project")){actor=f.owner();target="/api/v1/workspaces/"+f.workspace()+"/projects/"+f.other()+"/collaboration";suffix="/operations/"+intent;expected=404;reason="operation_not_found";}
        if(branch.endsWith("unknown")){actor=f.owner();expected=404;if(branch.equals("preview-unknown")){suffix="/previews/9223372036854775806";reason="preview_not_found";}else if(branch.equals("publication-unknown")){suffix="/publications/9223372036854775806";reason="publication_not_found";}else{suffix="/operations/"+UUID.randomUUID();reason="operation_not_found";}}
        if(branch.equals("publication-history")){suffix="/publications/"+published.path("id").asText();capability(f,f.viewer(),"history.read","deny");}
        if(branch.equals("publication-project")||branch.equals("preview-project")){actor=f.owner();target="/api/v1/workspaces/"+f.workspace()+"/projects/"+f.other()+"/collaboration";expected=404;reason=branch.equals("publication-project")?"publication_not_found":"preview_not_found";if(branch.equals("publication-project"))suffix="/publications/"+published.path("id").asText();}
        var response=branch.equals("delete-preview")?request(actor.token(),delete(target+suffix),Map.of()).andReturn().getResponse():mvc.perform(get(target+suffix).header("Authorization","Bearer "+actor.token())).andReturn().getResponse();var result=response.getContentAsByteArray().length==0?json.createObjectNode():json.readTree(response.getContentAsByteArray());
        int status=expected;String code=reason;assertAll(()->assertEquals(status,response.getStatus()),()->assertEquals(code,result.path("code").asText("missing")));
    }
    @Test void publicationDocumentReadDoesNotInheritHistoryDenial()throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),documentRequest(f));var published=publish(f,candidate,UUID.randomUUID().toString());publication(f,f.viewer(),published.path("id").asText());
        capability(f,f.viewer(),"history.read","deny");mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+f.viewer().token())).andExpect(status().isOk());
        var read=publication(f,f.viewer(),published.path("id").asText());assertAll(()->assertTrue(candidate.path("artifact").equals(read.path("artifact")),"visible document keeps exact safe body"),()->assertEquals(candidate.path("candidateDigest"),read.path("digest")));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(booleans={false,true})
    void publicationPreviewBodyUsesCurrentSourceRead(boolean document)throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),document?documentRequest(f):reportRequest(f));String path=collaboration(f)+"/previews/"+candidate.path("id").asText();
        mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());capability(f,f.owner(),"history.read","deny");
        mvc.perform(get(f.url()+"/assets").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk());var response=mvc.perform(get(path).header("Authorization","Bearer "+f.owner().token())).andReturn().getResponse();var result=json.readTree(response.getContentAsByteArray());
        if(document)assertAll(()->assertEquals(200,response.getStatus()),()->assertTrue(candidate.path("artifact").equals(result.path("artifact")),"history denial does not hide document preview"),()->assertEquals(candidate.path("candidateDigest"),result.path("candidateDigest")));
        else assertAll(()->assertEquals(403,response.getStatus()),()->assertEquals("forbidden",result.path("code").asText("missing")));
    }
    @Test void publicationStoredCopySurvivesActualSourceRemoval()throws Exception {
        var f=fixture();var candidate=preview(f,f.owner(),reportRequest(f));var published=publish(f,candidate,UUID.randomUUID().toString());jdbc.update("UPDATE execution_jobs SET report_state='expired',report_content=NULL WHERE id=?",Long.parseLong(f.job()));
        var read=publication(f,f.viewer(),published.path("id").asText());assertAll(()->assertTrue(candidate.path("artifact").equals(read.path("artifact")),"independent complete fixed copy"),()->assertEquals(candidate.path("candidateDigest"),read.path("digest")),()->assertEquals(1,rpc.requests.size()));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"trust","revision","digest","kind"})
    void publicationRpcResultMustMatchFixedSource(String mismatch)throws Exception {
        var f=fixture();preview(f,f.owner(),documentRequest(f));rpc.mismatch=mismatch;previewReject(f,f.owner(),documentRequest(f),502,"publication_projection_mismatch");
    }
    @Test void publicationRpcUnavailabilityIsExplicitAndDoesNotSaveCandidate()throws Exception {
        var f=fixture();preview(f,f.owner(),documentRequest(f));rpc.unavailable=true;previewReject(f,f.owner(),documentRequest(f),503,"collaboration_projection_unavailable");
    }
}
