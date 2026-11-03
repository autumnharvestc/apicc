package com.autumnharvestc.server.collaboration;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.MissingNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.math.BigDecimal;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real policy reads; literal spec values, independent old authority controls, no policy/RPC mocks. */
class CollaborationPolicyTest extends CollaborationApiFixture {
    @Test void t10LegalLongDefaultIsInsideAdvertisedHardRange()throws Exception {
        bindPolicy(Map.of("defaults.max-share-duration-ms",31_536_000_000L));
        var f=policyFixture();
        var saved=savePolicy(f.owner(),f.scope(false),patch(0,Map.of("defaultShareDurationMs",10_368_000_000L)));
        assertEquals(10_368_000_000L,row(saved,"defaultShareDurationMs").path("effective").asLong(-1),"legal120day save reached");
        var current=read(f.owner(),f.scope(false));
        assertEquals(10_368_000_000L,row(current,"defaultShareDurationMs").path("local").asLong(-1),"real read retains saved value");
        assertThat(row(current,"defaultShareDurationMs").path("maximum").asLong(-1)).isGreaterThanOrEqualTo(10_368_000_000L);
    }
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties deploymentPolicy;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.runtime.RuntimeProperties policyRuntime;
    final Map<String,Object> deploymentInput=new LinkedHashMap<>();
    @org.junit.jupiter.api.BeforeEach void resetPolicyDeployment() {
        org.springframework.beans.BeanUtils.copyProperties(new com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties(),deploymentPolicy);
        deploymentInput.clear();
        policyRuntime.setConnectTimeoutMs(3000);policyRuntime.setCallTimeoutMs(10000);policyRuntime.setMockTimeoutMs(35000);policyRuntime.setMaxWireBytes(33554432);
        jdbc.update("DELETE FROM collaboration_policy WHERE workspace_id=0 AND project_id=0");
    }
    void bindPolicy(Map<String,?> properties) {
        properties.forEach(deploymentInput::put);var source=new org.springframework.boot.context.properties.source.MapConfigurationPropertySource();deploymentInput.forEach((name,value)->source.put("apicc.collaboration.policy."+name,value));
        assertTrue(new org.springframework.boot.context.properties.bind.Binder(source).bind("apicc.collaboration.policy",org.springframework.boot.context.properties.bind.Bindable.ofInstance(deploymentPolicy)).isBound(),"real deployment Binder reached");
    }
    void allowOrigins(List<String> origins){var properties=new LinkedHashMap<String,Object>();for(int i=0;i<origins.size();i++)properties.put("defaults.cors-allowed-origins["+i+"]",origins.get(i));bindPolicy(properties);}
    Actor platformActor()throws Exception{return new Actor("platform",login("admin","admin-pass-2026"),null);}
    static final String PLATFORM_SCOPE="/api/v1/admin";
    void configuredPolicy() {
        bindPolicy(Map.ofEntries(
            Map.entry("defaults.external-sharing-allowed",true),Map.entry("defaults.shared-mock-allowed",true),Map.entry("defaults.evidence-allowed",true),Map.entry("defaults.external-download-allowed",true),
            Map.entry("defaults.max-source-bytes",67108864),Map.entry("defaults.max-artifact-bytes",33554432),Map.entry("defaults.max-field-bytes",65536),Map.entry("defaults.max-evidence-bytes",8388608),
            Map.entry("defaults.max-project-versions",100000),Map.entry("defaults.max-project-storage-bytes",10737418240L),Map.entry("defaults.max-project-active-grants",10000),
            Map.entry("deployment.deployment-max-storage-bytes",107374182400L),Map.entry("deployment.deployment-max-active-grants",100000),Map.entry("deployment.node-cache-bytes",8388608),
            Map.entry("resources.cpu-vcpu","1.25"),Map.entry("resources.total-memory-bytes",1073741824),Map.entry("resources.node-heap-bytes",134217728),
            Map.entry("resources.in-flight-bytes",268435456),Map.entry("resources.headroom-bytes",67108864)));
        policyRuntime.setMaxWireBytes(134217728);policyRuntime.setMockTimeoutMs(120000);
    }
    record PolicyFixture(Actor owner,Actor admin,Actor projectAdmin,Actor viewer,String workspace,String group,String project) {
        String scope(boolean projectScope){return "/api/v1/workspaces/"+workspace+(projectScope?"/projects/"+project:"");}
    }
    PolicyFixture policyFixture()throws Exception {
        var owner=actor();var admin=actor();var projectAdmin=actor();var viewer=actor();
        String ws=body(request(owner.token(),post("/api/v1/workspaces"),Map.of("name","T6 policy "+owner.id())).andExpect(status().isCreated())).path("id").asText();
        String group=body(request(owner.token(),post("/api/v1/workspaces/"+ws+"/groups"),Map.of("name","Policy")).andExpect(status().isCreated())).path("id").asText();
        String project=project(owner,ws,group);
        for(var member:List.of(Map.entry(admin,"ADMIN"),Map.entry(projectAdmin,"VIEWER"),Map.entry(viewer,"VIEWER")))
            request(owner.token(),put("/api/v1/workspaces/"+ws+"/members/"+member.getKey().id()),Map.of("role",member.getValue(),"expectedRevision",0)).andExpect(status().isOk());
        var result=new PolicyFixture(owner,admin,projectAdmin,viewer,ws,group,project);
        acl(result,projectAdmin,"ADMIN",0);return result;
    }
    void acl(PolicyFixture f,Actor target,String role,long revision)throws Exception {
        request(f.owner().token(),put(f.scope(true)+"/acl"),Map.of("userId",target.id(),"role",role,"expectedRevision",revision)).andExpect(status().isOk());
    }
    JsonNode read(Actor actor,String scope)throws Exception {
        return body(mvc.perform(get(scope+"/collaboration/policy").header("Authorization","Bearer "+actor.token())).andExpect(status().isOk()));
    }
    void oldAuthority(Actor actor,String scope,int statusCode,String code)throws Exception {
        var result=mvc.perform(get(scope+"/access-policy").header("Authorization","Bearer "+actor.token())).andExpect(status().is(statusCode));
        if(code!=null)result.andExpect(jsonPath("$.code").value(code));
    }
    void denied(Actor actor,String scope,String code,int statusCode)throws Exception {
        mvc.perform(get(scope+"/collaboration/policy").header("Authorization","Bearer "+actor.token())).andExpect(status().is(statusCode)).andExpect(jsonPath("$.code").value(code));
    }
    record Expected(String code,Object value,String type,String unit,String effect,Long minimum,Long maximum,Integer maxItems,Integer maxItemCodePoints) {}
    Expected bool(String code,boolean value,String effect){return new Expected(code,value,"boolean","boolean",effect,null,null,null,null);}
    Expected number(String code,long value,String unit,String effect,long minimum,long maximum){return new Expected(code,value,"integer",unit,effect,minimum,maximum,null,null);}
    Expected strings(String code,int items,int itemSize,String effect){return new Expected(code,List.of(),"string-list","items",effect,null,null,items,itemSize);}
    List<Expected> defaults() {
        return List.of(
            bool("externalSharingAllowed",false,"current-access-and-new-grants"),
            bool("historyPublishingAllowed",true,"new-publications"),bool("sharedMockAllowed",false,"new-publications"),
            number("defaultShareDurationMs",604_800_000L,"milliseconds","new-grants",60_000L,31_536_000_000L),
            number("maxShareDurationMs",7_776_000_000L,"milliseconds","current-access-and-new-grants",60_000L,31_536_000_000L),
            bool("externalDownloadAllowed",false,"each-download"),
            number("previewTtlMs",600_000,"milliseconds","new-previews",60_000,3_600_000),
            number("maxPreviewsPerPerson",5,"count","new-previews",1,1000),number("maxPreviewsPerProject",20,"count","new-previews",1,1000),number("maxPreviewsGlobal",100,"count","new-previews",1,1000),
            number("publicationOperationTimeoutMs",60_000,"milliseconds","new-operations",5000,300_000),
            number("maxSourceBytes",16_777_216,"bytes","new-publications",1_048_576,67_108_864),number("maxArtifactBytes",8_388_608,"bytes","new-publications",65_536,33_554_432),
            bool("evidenceAllowed",false,"new-projections-and-existing-grant-compliance"),
            number("maxFieldBytes",8192,"bytes","new-projections",256,65_536),number("maxEvidenceBytes",1_048_576,"bytes","new-projections",4096,8_388_608),
            number("maxProjectVersions",1000,"count","new-storage-writes",1,100_000),number("maxProjectStorageBytes",268_435_456,"bytes","new-storage-writes",8_388_608,10_737_418_240L),
            number("maxProjectActiveGrants",100,"count","new-or-rotated-grants",1,10_000),
            number("inactiveArtifactRetentionMs",2_592_000_000L,"milliseconds","eligible-cleanup",86_400_000,31_536_000_000L),
            number("memberUploadRetentionMs",2_592_000_000L,"milliseconds","new-uploads-and-retention",86_400_000,31_536_000_000L),number("maxMemberUploadRecords",1000,"count","new-uploads-and-retention",1,100_000),
            number("defaultPageSize",50,"count","each-list-read",1,200),number("maxPageSize",200,"count","each-list-read",1,200),
            number("publicReadRps",10,"requests-per-second","each-admission",1,1000),number("publicReadInFlight",8,"count","each-admission",1,256),
            number("mockRps",20,"requests-per-second","each-admission",1,1000),number("mockInFlight",16,"count","each-admission",1,256),
            number("maxMockRequestBytes",1_048_576,"bytes","each-mock-call",1024,8_388_608),number("maxMockResponseBytes",1_048_576,"bytes","each-mock-call",1024,8_388_608),
            number("maxMockDelayMs",30_000,"milliseconds","new-plans-and-current-calls",0,30_000),number("mockCallTimeoutMs",35_000,"milliseconds","new-plans-and-current-calls",1000,120_000),
            number("mockLogMaxEntries",200,"count","new-log-entries-and-cleanup",0,10_000),number("mockLogRetentionMs",86_400_000,"milliseconds","new-log-entries-and-cleanup",3_600_000,2_592_000_000L),
            strings("extraSensitiveHeaders",200,256,"new-projections-and-existing-grant-compliance"),strings("extraSensitiveQuery",200,256,"new-projections-and-existing-grant-compliance"),
            strings("extraSensitiveFields",200,256,"new-projections-and-existing-grant-compliance"),strings("extraSensitivePointers",200,256,"new-projections-and-existing-grant-compliance"),strings("corsAllowedOrigins",50,512,"each-browser-call"),
            number("managementAuditRetentionMs",7_776_000_000L,"milliseconds","audit-cleanup",604_800_000,315_360_000_000L),number("accessAuditRetentionMs",604_800_000,"milliseconds","new-access-records-and-cleanup",0,7_776_000_000L),
            number("cleanupBatchSize",100,"count","next-cleanup-cycle",1,1000),number("cleanupIntervalMs",3_600_000,"milliseconds","next-cleanup-cycle",60_000,86_400_000),
            number("rpcConnectTimeoutMs",3000,"milliseconds","new-rpc-calls",100,30_000),number("rpcCallTimeoutMs",10_000,"milliseconds","new-rpc-calls",1000,300_000),
            number("deploymentMaxStorageBytes",1_073_741_824,"bytes","new-storage-writes",67_108_864,107_374_182_400L),
            number("deploymentPublicReadRps",100,"requests-per-second","each-admission",1,10_000),number("deploymentPublicReadInFlight",64,"count","each-admission",1,1024),
            number("deploymentMockRps",100,"requests-per-second","each-admission",1,10_000),number("deploymentMockInFlight",64,"count","each-admission",1,1024),number("deploymentMaxActiveGrants",1000,"count","new-or-rotated-grants",1,100_000),
            number("nodeCacheBytes",67_108_864,"bytes","runtime-startup",8_388_608,1_073_741_824),number("rpcMaxMessageBytes",33_554_432,"bytes","runtime-startup",1_048_576,134_217_728)
        );
    }
    JsonNode row(JsonNode view,String code) {
        for(var entry:view.path("settings"))if(entry.path("code").asText().equals(code))return entry;
        return MissingNode.getInstance();
    }
    @Test void scopeReadsExposeAllTypedBuiltinAndEffectiveDefaults()throws Exception {
        var f=policyFixture();var checks=new ArrayList<Executable>();
        for(boolean project:List.of(false,true)) {
            oldAuthority(f.owner(),f.scope(project),200,null);var view=read(f.owner(),f.scope(project));
            assertThat(view.isObject()).isTrue();assertThat(view.path("settings").isArray()).isTrue();
            checks.add(()->assertEquals(defaults().size(),view.path("settings").size(),"finite default row count"));
            for(var expected:defaults()) {
                var entry=row(view,expected.code());String label=(project?"project/":"workspace/")+expected.code();
                checks.add(()->assertAll(label,
                    ()->assertEquals(json.readTree(json.writeValueAsBytes(expected.value())),entry.path("builtin"),"builtin"),
                    ()->assertEquals(json.readTree(json.writeValueAsBytes(expected.value())),entry.path("effective"),"effective"),
                    ()->assertTrue(entry.path("local").isNull(),"null local means inherit"),
                    ()->assertEquals(expected.type(),entry.path("valueType").asText("missing"),"type"),
                    ()->assertEquals("builtin",entry.path("source").asText("missing"),"source"),
                    ()->assertEquals(expected.unit(),entry.path("unit").asText("missing"),"unit"),
                    ()->assertEquals(expected.effect(),entry.path("effect").asText("missing"),"effect"),
                    ()->{if(expected.minimum()!=null)assertEquals(expected.minimum().longValue(),entry.path("minimum").asLong(-1),"minimum");},
                    ()->{if(expected.maximum()!=null)assertEquals(expected.maximum().longValue(),entry.path("maximum").asLong(-1),"maximum");},
                    ()->{if(expected.maxItems()!=null)assertEquals(expected.maxItems().intValue(),entry.path("maxItems").asInt(-1),"maxItems");},
                    ()->{if(expected.maxItemCodePoints()!=null)assertEquals(expected.maxItemCodePoints().intValue(),entry.path("maxItemCodePoints").asInt(-1),"maxItemCodePoints");}
                ));
            }
        }
        assertAll(checks);
    }
    @Test void localCasAndInitialEffectiveProjectionRevisionAreDistinct()throws Exception {
        var f=policyFixture();var workspace=read(f.owner(),f.scope(false));var project=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(0,workspace.path("revision").asLong(-1)),()->assertEquals(0,project.path("revision").asLong(-1)),
            ()->assertEquals(1,workspace.path("projectionRevision").asLong(-1)),()->assertEquals(1,project.path("projectionRevision").asLong(-1)));
    }
    @Test void recommendationsDoNotClaimConfiguredExternalOrApplicationLimits()throws Exception {
        var f=policyFixture();var resources=read(f.owner(),f.scope(true)).path("resources");var recommended=resources.path("recommendations");
        assertAll(
            ()->assertEquals(new BigDecimal("1"),recommended.path("cpuVcpu").path("value").decimalValue()),
            ()->assertEquals(new BigDecimal("0.25"),recommended.path("cpuVcpu").path("minimum").decimalValue()),
            ()->assertEquals(new BigDecimal("8"),recommended.path("cpuVcpu").path("maximum").decimalValue()),
            ()->assertEquals("vCPU",recommended.path("cpuVcpu").path("unit").asText("missing")),
            ()->assertEquals(805_306_368,recommended.path("totalMemoryBytes").path("value").asLong(-1)),
            ()->assertEquals(268_435_456,recommended.path("totalMemoryBytes").path("minimum").asLong(-1)),
            ()->assertEquals(8_589_934_592L,recommended.path("totalMemoryBytes").path("maximum").asLong(-1)),
            ()->assertEquals(402_653_184,recommended.path("nodeHeapBytes").path("value").asLong(-1)),
            ()->assertEquals(134_217_728,recommended.path("nodeHeapBytes").path("minimum").asLong(-1)),
            ()->assertEquals(4_294_967_296L,recommended.path("nodeHeapBytes").path("maximum").asLong(-1)),
            ()->assertEquals("bytes",recommended.path("totalMemoryBytes").path("unit").asText("missing")),
            ()->assertEquals("bytes",recommended.path("nodeHeapBytes").path("unit").asText("missing")),
            ()->assertAll("unconfigured external CPU",unconfigured(resources.path("externalLimits").path("cpuVcpu"),"vCPU")),
            ()->assertAll("unconfigured external RSS",unconfigured(resources.path("externalLimits").path("totalMemoryBytes"),"bytes")),
            ()->assertAll("unconfigured application heap",unconfigured(resources.path("applicationSettings").path("nodeHeapBytes"),"bytes"))
        );
    }
    Executable[] unconfigured(JsonNode limit,String unit) {
        return new Executable[]{()->assertTrue(limit.path("value").isNull(),"no configured limit value"),()->assertEquals("unconfigured",limit.path("status").asText("missing")),()->assertEquals(unit,limit.path("unit").asText("missing"))};
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void viewerCannotReadManagedPolicy(boolean project)throws Exception {
        var f=policyFixture();read(f.owner(),f.scope(project));oldAuthority(f.viewer(),f.scope(project),403,"forbidden");
        denied(f.viewer(),f.scope(project),"forbidden",403);
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void nonmemberCannotReadManagedPolicy(boolean project)throws Exception {
        var f=policyFixture();var outsider=actor();read(f.owner(),f.scope(project));oldAuthority(outsider,f.scope(project),403,"forbidden");
        denied(outsider,f.scope(project),"forbidden",403);
    }
    @Test void projectAdministratorCannotManageWorkspacePolicy()throws Exception {
        var f=policyFixture();oldAuthority(f.projectAdmin(),f.scope(true),200,null);read(f.projectAdmin(),f.scope(true));
        oldAuthority(f.projectAdmin(),f.scope(false),403,"forbidden");denied(f.projectAdmin(),f.scope(false),"forbidden",403);
    }
    @Test void workspaceAdministratorCanManagePolicyDespiteContentNone()throws Exception {
        var f=policyFixture();acl(f,f.admin(),"NONE",0);oldAuthority(f.admin(),f.scope(true),200,null);
        mvc.perform(get(f.scope(true)+"/assets").header("Authorization","Bearer "+f.admin().token())).andExpect(status().isForbidden());
        read(f.admin(),f.scope(true));
    }
    @Test void managementChecksAddressedProjectWorkspace()throws Exception {
        var f=policyFixture();String other=body(request(f.owner().token(),post("/api/v1/workspaces"),Map.of("name","T6 wrong scope "+f.owner().id())).andExpect(status().isCreated())).path("id").asText();
        read(f.owner(),f.scope(true));oldAuthority(f.owner(),"/api/v1/workspaces/"+other,200,null);
        String wrong="/api/v1/workspaces/"+other+"/projects/"+f.project();oldAuthority(f.owner(),wrong,404,"project_not_found");denied(f.owner(),wrong,"project_not_found",404);
    }
    @Test void unqualifiedViewerDoesNotLearnWrongProjectScope()throws Exception {
        var f=policyFixture();String wrong="/api/v1/workspaces/"+f.workspace()+"/projects/9223372036854775806";
        oldAuthority(f.viewer(),wrong,403,"forbidden");denied(f.viewer(),wrong,"forbidden",403);
    }
    @Test void explicitNoneRevokesProjectPolicyManagement()throws Exception {
        var f=policyFixture();oldAuthority(f.projectAdmin(),f.scope(true),200,null);read(f.projectAdmin(),f.scope(true));acl(f,f.projectAdmin(),"NONE",1);
        oldAuthority(f.projectAdmin(),f.scope(true),403,"forbidden");denied(f.projectAdmin(),f.scope(true),"forbidden",403);
    }
    @Test void pendingOverrideDoesNotRestorePolicyManagement()throws Exception {
        var f=policyFixture();oldAuthority(f.projectAdmin(),f.scope(true),200,null);read(f.projectAdmin(),f.scope(true));String member=f.scope(false)+"/members/"+f.projectAdmin().id();
        long revision=body(mvc.perform(get(f.scope(false)+"/access-members/"+f.projectAdmin().id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
        request(f.owner().token(),delete(member).param("expectedRevision",String.valueOf(revision)),Map.of()).andExpect(status().isNoContent());
        long removed=body(mvc.perform(get(f.scope(false)+"/access-members/"+f.projectAdmin().id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
        request(f.owner().token(),put(member),Map.of("role","VIEWER","expectedRevision",removed)).andExpect(status().isOk());
        mvc.perform(get(f.scope(true)+"/access").header("Authorization","Bearer "+f.projectAdmin().token())).andExpect(status().isOk()).andExpect(jsonPath("$.overrideState").value("pending-confirmation"));
        oldAuthority(f.projectAdmin(),f.scope(true),403,"forbidden");denied(f.projectAdmin(),f.scope(true),"forbidden",403);
    }
    @Test void platformAdministratorDoesNotInheritProjectPolicyRights()throws Exception {
        var f=policyFixture();String token=login("admin","admin-pass-2026");var platform=new Actor("unused",token,null);
        read(f.owner(),f.scope(true));oldAuthority(platform,f.scope(true),403,"forbidden");denied(platform,f.scope(true),"forbidden",403);
    }
    @Test void authenticationRemainsInherited()throws Exception {
        var f=policyFixture();mvc.perform(get(f.scope(true)+"/collaboration/policy")).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("unauthorized"));
    }
    com.fasterxml.jackson.databind.node.ObjectNode patch(long revision,Map<String,?> settings) {
        var request=json.createObjectNode().put("expectedRevision",revision);request.set("settings",json.valueToTree(settings));return request;
    }
    JsonNode savePolicy(Actor actor,String scope,JsonNode patch)throws Exception {
        return body(request(actor.token(),put(scope+"/collaboration/policy"),patch).andExpect(status().isOk()));
    }
    PolicyFixture writeControl()throws Exception {
        var f=policyFixture();oldAuthority(f.owner(),f.scope(true),200,null);
        var saved=savePolicy(f.owner(),f.scope(true),patch(0,Map.of("maxProjectVersions",900)));
        assertThat(saved.path("revision").asLong(-1)).isEqualTo(1);
        assertThat(row(saved,"maxProjectVersions").path("local").asLong(-1)).isEqualTo(900);
        assertThat(row(read(f.owner(),f.scope(true)),"maxProjectVersions").path("effective").asLong(-1)).isEqualTo(900);
        return f;
    }
    long revision(PolicyFixture f)throws Exception{return read(f.owner(),f.scope(true)).path("revision").asLong(-1);}
    void budgetControl(PolicyFixture f)throws Exception {
        var saved=savePolicy(f.owner(),f.scope(true),patch(revision(f),Map.of("maxProjectVersions",900,"maxFieldBytes",256,"maxEvidenceBytes",4096,"maxArtifactBytes",65_536)));
        assertAll(()->assertEquals(256,row(saved,"maxFieldBytes").path("effective").asLong(-1)),
            ()->assertEquals(4096,row(saved,"maxEvidenceBytes").path("effective").asLong(-1)),
            ()->assertEquals(65_536,row(saved,"maxArtifactBytes").path("effective").asLong(-1)));
    }
    void rejectPolicyWrite(PolicyFixture f,Actor writer,String target,JsonNode mutation,int expectedStatus,String code)throws Exception {
        long before=revision(f),rows=jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_policy",Long.class);
        var response=request(writer.token(),put(target+"/collaboration/policy"),mutation).andReturn().getResponse();
        var result=json.readTree(response.getContentAsByteArray());var after=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(expectedStatus,response.getStatus(),"mutation HTTP status"),()->assertEquals(code,result.path("code").asText("missing"),"stable reason"),
            ()->assertEquals(before,after.path("revision").asLong(-1),"no accepted policy mutation"),
            ()->assertEquals(rows,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_policy",Long.class),"no extra scope row"),
            ()->assertEquals(900,row(after,"maxProjectVersions").path("local").asLong(-1),"original local retained"));
    }
    @Test void partialPolicyWritePreservesOmittedOverrides()throws Exception {
        var f=writeControl();var result=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxPageSize",100)));
        assertAll(()->assertEquals(2,result.path("revision").asLong(-1)),()->assertEquals(900,row(result,"maxProjectVersions").path("local").asLong(-1)),
            ()->assertEquals(100,row(result,"maxPageSize").path("local").asLong(-1)));
    }
    @Test void nullClearsOnlyTheSelectedOverride()throws Exception {
        var f=writeControl();savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900,"maxPageSize",100)));
        var clear=new LinkedHashMap<String,Object>();clear.put("maxProjectVersions",null);
        var result=savePolicy(f.owner(),f.scope(true),patch(2,clear));
        assertAll(()->assertTrue(row(result,"maxProjectVersions").path("local").isNull()),
            ()->assertEquals(1000,row(result,"maxProjectVersions").path("effective").asLong(-1)),
            ()->assertEquals(100,row(result,"maxPageSize").path("local").asLong(-1)));
    }
    @Test void falseZeroAndEmptyListAreExplicitOverrides()throws Exception {
        var f=writeControl();var result=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("historyPublishingAllowed",false,"mockLogMaxEntries",0,"extraSensitiveFields",List.of())));
        assertAll(()->assertEquals(json.readTree("false"),row(result,"historyPublishingAllowed").path("local")),
            ()->assertEquals(0,row(result,"mockLogMaxEntries").path("local").asLong(-1)),
            ()->assertEquals(json.readTree("[]"),row(result,"extraSensitiveFields").path("local")),
            ()->assertEquals("project",row(result,"historyPublishingAllowed").path("source").asText("missing")));
    }
    @Test void nonemptyMatchingCommandsRemainAccepted()throws Exception {
        var f=writeControl();var same=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900)));
        assertThat(same.path("revision").asLong(-1)).isEqualTo(2);
        var clear=new LinkedHashMap<String,Object>();clear.put("evidenceAllowed",null);
        assertThat(savePolicy(f.owner(),f.scope(true),patch(2,clear)).path("revision").asLong(-1)).isEqualTo(3);
    }
    @Test void projectionIdentityAdvancesAcrossSaveClearAndRecreate()throws Exception {
        var f=policyFixture();long initial=read(f.owner(),f.scope(true)).path("projectionRevision").asLong(-1);
        var first=savePolicy(f.owner(),f.scope(true),patch(0,Map.of("maxProjectVersions",900)));
        var clear=new LinkedHashMap<String,Object>();clear.put("maxProjectVersions",null);
        var second=savePolicy(f.owner(),f.scope(true),patch(1,clear));var third=savePolicy(f.owner(),f.scope(true),patch(2,Map.of("maxProjectVersions",900)));
        assertAll(()->assertTrue(first.path("projectionRevision").asLong(-1)>initial,"save advances epoch"),
            ()->assertTrue(second.path("projectionRevision").asLong(-1)>first.path("projectionRevision").asLong(-1),"clear retains monotonic identity"),
            ()->assertTrue(third.path("projectionRevision").asLong(-1)>second.path("projectionRevision").asLong(-1),"recreate never resets identity"));
    }
    @ParameterizedTest @ValueSource(strings={"empty-settings","missing-settings","root-array","settings-array","unknown-top","unknown-setting","response-metadata","integer-text","integer-fraction","boolean-text","list-item-number","missing-revision","null-revision","text-revision","fraction-revision","negative-revision","unsafe-revision","boolean-revision"})
    void strictPolicyMutationShapeAndRevision(String branch)throws Exception {
        var f=writeControl();var mutation=patch(1,Map.of("maxProjectVersions",800));JsonNode request=mutation;
        switch(branch) {
            case "empty-settings"->mutation.putObject("settings");case "missing-settings"->mutation.remove("settings");
            case "root-array"->request=json.createArrayNode();case "settings-array"->mutation.set("settings",json.createArrayNode());
            case "unknown-top"->mutation.put("candidateDigest","untrusted-metadata");case "unknown-setting"->mutation.putObject("settings").put("arbitraryBudget",800);
            case "response-metadata"->mutation.putObject("settings").put("source","project");
            case "integer-text"->mutation.putObject("settings").put("maxProjectVersions","800");case "integer-fraction"->mutation.putObject("settings").put("maxProjectVersions",800.5);
            case "boolean-text"->mutation.putObject("settings").put("historyPublishingAllowed","false");case "list-item-number"->mutation.putObject("settings").putArray("extraSensitiveFields").add(42);
            case "missing-revision"->mutation.remove("expectedRevision");case "null-revision"->mutation.putNull("expectedRevision");case "text-revision"->mutation.put("expectedRevision","1");
            case "fraction-revision"->mutation.put("expectedRevision",1.5);case "negative-revision"->mutation.put("expectedRevision",-1);
            case "unsafe-revision"->mutation.put("expectedRevision",9_007_199_254_740_992L);case "boolean-revision"->mutation.put("expectedRevision",true);
        }
        rejectPolicyWrite(f,f.owner(),f.scope(true),request,400,"validation_failed");
    }
    @ParameterizedTest @ValueSource(strings={"deploymentMaxStorageBytes","deploymentPublicReadRps","deploymentPublicReadInFlight","deploymentMockRps","deploymentMockInFlight","deploymentMaxActiveGrants","maxPreviewsGlobal","rpcConnectTimeoutMs","rpcCallTimeoutMs","rpcMaxMessageBytes","nodeCacheBytes"})
    void deploymentOnlyPolicySettingsAreReadonly(String code)throws Exception {
        var f=writeControl();long legal= switch(code) {
            case "deploymentMaxStorageBytes"->1_073_741_824;case "deploymentPublicReadRps","deploymentMockRps","maxPreviewsGlobal"->100;
            case "deploymentPublicReadInFlight","deploymentMockInFlight"->64;case "deploymentMaxActiveGrants"->1000;case "rpcConnectTimeoutMs"->3000;
            case "rpcCallTimeoutMs"->10_000;case "rpcMaxMessageBytes"->33_554_432;case "nodeCacheBytes"->67_108_864;default->throw new IllegalArgumentException("Unexpected test code");
        };
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(1,Map.of(code,legal)),400,"collaboration_policy_read_only");
    }
    @Test void stalePolicyRevisionCannotOverwriteAcceptedChange()throws Exception {
        var f=writeControl();rejectPolicyWrite(f,f.owner(),f.scope(true),patch(0,Map.of("maxProjectVersions",800)),409,"collaboration_policy_revision_conflict");
    }
    @ParameterizedTest @ValueSource(strings={"source-min","artifact-min","field-min","evidence-min","preview-min","page-max","mock-log-min","share-max"})
    void policyScalarRangesRejectWithoutClamping(String branch)throws Exception {
        var f=writeControl();budgetControl(f);Map<String,?> values=switch(branch) {
            case "source-min"->Map.of("maxSourceBytes",1_048_575);case "artifact-min"->Map.of("maxFieldBytes",256,"maxEvidenceBytes",4096,"maxArtifactBytes",65_535);
            case "field-min"->Map.of("maxFieldBytes",255,"maxEvidenceBytes",4096,"maxArtifactBytes",65_536);case "evidence-min"->Map.of("maxFieldBytes",256,"maxEvidenceBytes",4095,"maxArtifactBytes",65_536);
            case "preview-min"->Map.of("previewTtlMs",59_999);case "page-max"->Map.of("maxPageSize",201);case "mock-log-min"->Map.of("mockLogMaxEntries",-1);
            case "share-max"->Map.of("maxShareDurationMs",31_536_000_001L);default->throw new IllegalArgumentException("Unexpected test branch");
        };
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(revision(f),values),400,"collaboration_policy_range_invalid");
    }
    @ParameterizedTest @ValueSource(strings={"field-evidence","evidence-artifact","default-share","default-page","combined-sensitive"})
    void policyCrossFieldsRejectWithoutClamping(String branch)throws Exception {
        var f=writeControl();budgetControl(f);Map<String,?> values=switch(branch) {
            case "field-evidence"->Map.of("maxFieldBytes",8192,"maxEvidenceBytes",4096,"maxArtifactBytes",65_536);
            case "evidence-artifact"->Map.of("maxFieldBytes",256,"maxEvidenceBytes",131_072,"maxArtifactBytes",65_536);
            case "default-share"->Map.of("defaultShareDurationMs",120_000,"maxShareDurationMs",60_000);
            case "default-page"->Map.of("defaultPageSize",101,"maxPageSize",100);
            case "combined-sensitive"->{
                var headers=java.util.stream.IntStream.range(0,100).mapToObj(i->"X-Extra-"+i).toList();var query=java.util.stream.IntStream.range(0,100).mapToObj(i->"q"+i).toList();
                savePolicy(f.owner(),f.scope(true),patch(revision(f),Map.of("maxProjectVersions",900,"maxFieldBytes",256,"maxEvidenceBytes",4096,"maxArtifactBytes",65_536,"extraSensitiveHeaders",headers,"extraSensitiveQuery",query)));
                yield Map.of("extraSensitiveHeaders",headers,"extraSensitiveQuery",java.util.stream.IntStream.range(0,101).mapToObj(i->"q"+i).toList());
            }
            default->throw new IllegalArgumentException("Unexpected test branch");
        };
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(revision(f),values),400,"collaboration_policy_combination_invalid");
    }
    @ParameterizedTest @ValueSource(strings={"header","pointer","unicode257","cors-wildcard","cors-path","cors-userinfo"})
    void sensitiveRulesAndOriginsRejectInvalidValues(String branch)throws Exception {
        var f=writeControl();String code,field,bad,good;
        switch(branch) {
            case "header"->{field="extraSensitiveHeaders";good="X-Extra";bad="Bad Header";code="collaboration_policy_sensitive_rule_invalid";}
            case "pointer"->{field="extraSensitivePointers";good="/nested/~0~1";bad="/nested/~2";code="collaboration_policy_sensitive_rule_invalid";}
            case "unicode257"->{field="extraSensitiveFields";good="🐢".repeat(256);bad="🐢".repeat(257);code="collaboration_policy_range_invalid";}
            case "cors-wildcard"->{field="corsAllowedOrigins";good="https://example.test";bad="https://*.example.test";code="collaboration_policy_origin_invalid";}
            case "cors-path"->{field="corsAllowedOrigins";good="https://example.test";bad="https://example.test/path";code="collaboration_policy_origin_invalid";}
            case "cors-userinfo"->{field="corsAllowedOrigins";good="https://example.test";bad="https://"+UUID.randomUUID()+"@example.test";code="collaboration_policy_origin_invalid";}
            default->throw new IllegalArgumentException("Unexpected test branch");
        }
        if(field.equals("corsAllowedOrigins"))allowOrigins(List.of(good));
        var positive=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900,field,List.of(good))));
        assertThat(row(positive,field).path("local").size()).isEqualTo(1);
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of(field,List.of(bad))),400,code);
    }
    @ParameterizedTest @ValueSource(strings={"viewer-project","viewer-workspace","outsider-project","outsider-workspace","project-admin-workspace","none","pending","platform","wrong-workspace","authority-before-target","authority-before-parser"})
    void newPolicyPutAuthorityIsIndependent(String branch)throws Exception {
        var f=writeControl();Actor writer=f.viewer();String target=f.scope(true),reason="forbidden";int status=403;JsonNode mutation=patch(1,Map.of("maxProjectVersions",800));
        switch(branch) {
            case "viewer-workspace"->target=f.scope(false);case "outsider-project"->writer=actor();case "outsider-workspace"->{writer=actor();target=f.scope(false);}
            case "project-admin-workspace"->{writer=f.projectAdmin();target=f.scope(false);}
            case "none"->{writer=f.projectAdmin();oldAuthority(writer,target,200,null);acl(f,writer,"NONE",1);}
            case "pending"->{
                writer=f.projectAdmin();String member=f.scope(false)+"/members/"+writer.id();
                long before=body(mvc.perform(get(f.scope(false)+"/access-members/"+writer.id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
                request(f.owner().token(),delete(member).param("expectedRevision",String.valueOf(before)),Map.of()).andExpect(status().isNoContent());
                long removed=body(mvc.perform(get(f.scope(false)+"/access-members/"+writer.id()).header("Authorization","Bearer "+f.owner().token())).andExpect(status().isOk())).path("revision").asLong();
                request(f.owner().token(),put(member),Map.of("role","VIEWER","expectedRevision",removed)).andExpect(status().isOk());
                mvc.perform(get(f.scope(true)+"/access").header("Authorization","Bearer "+writer.token())).andExpect(status().isOk()).andExpect(jsonPath("$.overrideState").value("pending-confirmation"));
            }
            case "platform"->writer=new Actor("unused",login("admin","admin-pass-2026"),null);
            case "wrong-workspace"->{writer=f.owner();String ws=body(request(writer.token(),post("/api/v1/workspaces"),Map.of("name","T6 PUT mismatch "+writer.id())).andExpect(status().isCreated())).path("id").asText();target="/api/v1/workspaces/"+ws+"/projects/"+f.project();status=404;reason="project_not_found";}
            case "authority-before-target"->target=f.scope(false)+"/projects/9223372036854775806";
            case "authority-before-parser"->mutation=json.createObjectNode().put("expectedRevision","not-a-revision").set("settings",json.createObjectNode().put("unknown",true));
        }
        oldAuthority(writer,target,status,reason);rejectPolicyWrite(f,writer,target,mutation,status,reason);
    }
    @Test void authorizedManagementWritesRetainSeparateContentRights()throws Exception {
        var f=writeControl();acl(f,f.admin(),"NONE",0);oldAuthority(f.admin(),f.scope(true),200,null);
        mvc.perform(get(f.scope(true)+"/assets").header("Authorization","Bearer "+f.admin().token())).andExpect(status().isForbidden());
        assertThat(savePolicy(f.admin(),f.scope(true),patch(1,Map.of("maxProjectVersions",800))).path("revision").asLong(-1)).isEqualTo(2);
        oldAuthority(f.projectAdmin(),f.scope(true),200,null);assertThat(savePolicy(f.projectAdmin(),f.scope(true),patch(2,Map.of("maxProjectVersions",700))).path("revision").asLong(-1)).isEqualTo(3);
    }
    @Test void concurrentPolicyCasHasOneDurableWinner()throws Exception {
        var f=writeControl();try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var start=new java.util.concurrent.CountDownLatch(1);
            var left=pool.submit(()->{start.await();return request(f.owner().token(),put(f.scope(true)+"/collaboration/policy"),patch(1,Map.of("maxProjectVersions",800))).andReturn().getResponse().getStatus();});
            var right=pool.submit(()->{start.await();return request(f.owner().token(),put(f.scope(true)+"/collaboration/policy"),patch(1,Map.of("maxProjectVersions",700))).andReturn().getResponse().getStatus();});start.countDown();
            var statuses=List.of(left.get(10,java.util.concurrent.TimeUnit.SECONDS),right.get(10,java.util.concurrent.TimeUnit.SECONDS));var finalView=read(f.owner(),f.scope(true));
            assertAll(()->assertThat(statuses).containsExactlyInAnyOrder(200,409),()->assertEquals(2,finalView.path("revision").asLong(-1)),
                ()->assertThat(row(finalView,"maxProjectVersions").path("local").asLong(-1)).isIn(700L,800L));
        }
    }
    @org.springframework.beans.factory.annotation.Autowired org.springframework.transaction.PlatformTransactionManager policyTransactions;
    @Test void policyWriteRechecksAuthorityAfterItsPolicyGateWait()throws Exception {
        var f=writeControl();var locked=new java.util.concurrent.CountDownLatch(1);var release=new java.util.concurrent.CountDownLatch(1);
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var blocker=pool.submit(()->new org.springframework.transaction.support.TransactionTemplate(policyTransactions).execute(tx->{
                jdbc.queryForObject("SELECT id FROM collaboration_policy_gate WHERE id=1 FOR UPDATE",Long.class);locked.countDown();
                try{if(!release.await(10,java.util.concurrent.TimeUnit.SECONDS))throw new IllegalStateException("Policy lock barrier timed out");acl(f,f.projectAdmin(),"NONE",1);}
                catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new RuntimeException(interrupted);}catch(Exception failure){throw new RuntimeException(failure);}return null;
            }));
            assertTrue(locked.await(5,java.util.concurrent.TimeUnit.SECONDS),"real policy gate held");
            var writer=pool.submit(()->request(f.projectAdmin().token(),put(f.scope(true)+"/collaboration/policy"),patch(1,Map.of("maxProjectVersions",800))).andReturn().getResponse().getStatus());
            boolean blocked=false;long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<deadline) {if(jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS WHERE BLOCKER_ID IS NOT NULL",Integer.class)>0){blocked=true;break;}Thread.sleep(10);}
            try{assertTrue(blocked,"HTTP writer reached actual blocked policy gate SQL");}finally{release.countDown();}
            blocker.get(5,java.util.concurrent.TimeUnit.SECONDS);int response=writer.get(5,java.util.concurrent.TimeUnit.SECONDS);
            assertAll(()->assertEquals(403,response,"revocation after wait is authoritative"),()->assertEquals(1,revision(f)),
                ()->assertEquals(900,row(read(f.owner(),f.scope(true)),"maxProjectVersions").path("local").asLong(-1)));
        }finally{release.countDown();}
    }
    @ParameterizedTest @ValueSource(strings={"sensitive","origins"})
    void policySupplementPerListLimits(String branch)throws Exception {
        var f=writeControl();boolean sensitive=branch.equals("sensitive");int exact=sensitive?200:50;String field=sensitive?"extraSensitiveFields":"corsAllowedOrigins";
        var accepted=java.util.stream.IntStream.range(0,exact).mapToObj(i->sensitive?"ordinaryField"+i:"https://host-"+i+".example.test").toList();
        if(!sensitive)allowOrigins(accepted);
        var positive=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900,field,accepted)));
        assertThat(row(positive,field).path("local").size()).isEqualTo(exact);
        var over=java.util.stream.IntStream.range(0,exact+1).mapToObj(i->sensitive?"ordinaryField"+i:"https://host-"+i+".example.test").toList();
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of(field,over)),400,"collaboration_policy_range_invalid");
    }
    @ParameterizedTest @ValueSource(strings={"scheme","query","fragment"})
    void policySupplementExactOriginComponents(String branch)throws Exception {
        var f=writeControl();allowOrigins(List.of("http://localhost:3210","https://example.test"));var positive=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900,"corsAllowedOrigins",List.of("http://localhost:3210","https://example.test"))));
        assertThat(row(positive,"corsAllowedOrigins").path("local").size()).isEqualTo(2);
        String origin=switch(branch){case "scheme"->"ftp://example.test";case "query"->"https://example.test?x=1";case "fragment"->"https://example.test#part";default->throw new IllegalArgumentException("Unexpected origin test");};
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of("corsAllowedOrigins",List.of(origin))),400,"collaboration_policy_origin_invalid");
    }
    @ParameterizedTest @ValueSource(strings={"extraSensitiveHeaders","extraSensitiveQuery","extraSensitiveFields"})
    void policySupplementEmptyOrdinaryNames(String field)throws Exception {
        var f=writeControl();var positive=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900,field,List.of("ordinaryField"),"extraSensitivePointers",List.of(""))));
        assertThat(row(positive,field).path("local").size()).isEqualTo(1);
        assertThat(row(positive,"extraSensitivePointers").path("local").size()).isEqualTo(1);
        assertThat(row(positive,"extraSensitivePointers").path("local").get(0).asText("missing")).isEmpty();
        if(field.equals("extraSensitiveHeaders"))rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of(field,List.of(""))),400,"collaboration_policy_sensitive_rule_invalid");
        else {
            var compatible=savePolicy(f.owner(),f.scope(true),patch(2,Map.of("maxProjectVersions",900,field,List.of(""),"extraSensitivePointers",List.of(""))));
            assertThat(row(compatible,field).path("local").size()).isEqualTo(1);
            assertThat(row(compatible,field).path("local").get(0).asText("missing")).isEmpty();
            assertThat(row(compatible,"extraSensitivePointers").path("local").size()).isEqualTo(1);
            assertThat(row(compatible,"extraSensitivePointers").path("local").get(0).asText("missing")).isEmpty();
        }
    }
    @Test void policySupplementRevisionBeyondLong()throws Exception {
        var f=writeControl();var mutation=patch(1,Map.of("maxProjectVersions",800));mutation.put("expectedRevision",new java.math.BigInteger("9223372036854775808"));
        rejectPolicyWrite(f,f.owner(),f.scope(true),mutation,400,"validation_failed");
    }
    @Test void policySupplementLocalRevisionExhaustion()throws Exception {
        var f=writeControl();long maximum=9_007_199_254_740_991L;
        jdbc.update("UPDATE collaboration_policy SET revision=? WHERE workspace_id=? AND project_id=?",maximum-1,Long.valueOf(f.workspace()),Long.valueOf(f.project()));
        var last=savePolicy(f.owner(),f.scope(true),patch(maximum-1,Map.of("maxProjectVersions",900)));
        assertThat(last.path("revision").asLong(-1)).isEqualTo(maximum);
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(maximum,Map.of("maxProjectVersions",800)),409,"collaboration_policy_revision_exhausted");
    }
    @ParameterizedTest @ValueSource(booleans={false,true})
    void policyD2DisabledAccountAfterWait(boolean projectScope)throws Exception {
        var f=policyFixture();String target=f.scope(projectScope);
        var before=savePolicy(f.admin(),target,patch(0,Map.of("maxProjectVersions",900)));
        assertEquals(1,before.path("revision").asLong(-1));long epoch=before.path("projectionRevision").asLong(-1);
        String platform=login("admin","admin-pass-2026");long accountRevision=-1;
        for(var user:body(mvc.perform(get("/api/v1/admin/users").header("Authorization","Bearer "+platform)).andExpect(status().isOk())))
            if(user.path("id").asText().equals(f.admin().id()))accountRevision=user.path("revision").asLong(-1);
        assertTrue(accountRevision>=0,"real current account revision");long expectedAccountRevision=accountRevision;
        var locked=new java.util.concurrent.CountDownLatch(1);var release=new java.util.concurrent.CountDownLatch(1);
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var blocker=pool.submit(()->new org.springframework.transaction.support.TransactionTemplate(policyTransactions).execute(tx->{
                jdbc.queryForObject("SELECT id FROM collaboration_policy_gate WHERE id=1 FOR UPDATE",Long.class);locked.countDown();
                try{
                    if(!release.await(10,java.util.concurrent.TimeUnit.SECONDS))throw new IllegalStateException("Policy account barrier timed out");
                    request(platform,post("/api/v1/admin/users/"+f.admin().id()+"/disable"),Map.of("expectedRevision",expectedAccountRevision)).andExpect(status().isNoContent());
                }catch(InterruptedException interrupted){Thread.currentThread().interrupt();throw new RuntimeException(interrupted);}catch(Exception failure){throw new RuntimeException(failure);}return null;
            }));
            assertTrue(locked.await(5,java.util.concurrent.TimeUnit.SECONDS));
            var writer=pool.submit(()->request(f.admin().token(),put(target+"/collaboration/policy"),patch(1,Map.of("maxProjectVersions",800))).andReturn().getResponse());
            boolean blocked=false;long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            while(System.nanoTime()<deadline){if(jdbc.queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS WHERE BLOCKER_ID IS NOT NULL",Integer.class)>0){blocked=true;break;}Thread.sleep(10);}
            try{assertTrue(blocked,"authenticated writer reached real policy gate SQL wait");}finally{release.countDown();}
            blocker.get(5,java.util.concurrent.TimeUnit.SECONDS);
            assertTrue(users.findById(Long.parseLong(f.admin().id())).orElseThrow().disabled(),"holder committed account revocation before writer acquires policy gate");
            var response=writer.get(5,java.util.concurrent.TimeUnit.SECONDS);var result=json.readTree(response.getContentAsByteArray());var after=read(f.owner(),target);
            assertAll(()->assertEquals(403,response.getStatus(),"disabled account cannot finish accepted policy command"),()->assertEquals("forbidden",result.path("code").asText("missing")),
                ()->assertEquals(1,after.path("revision").asLong(-1)),()->assertEquals(epoch,after.path("projectionRevision").asLong(-1)),()->assertEquals(900,row(after,"maxProjectVersions").path("local").asLong(-1)));
        }finally{release.countDown();}
    }
    @Test void policyD2ProjectionEpochExhaustion()throws Exception {
        var f=writeControl();long maximum=9_007_199_254_740_991L;
        jdbc.update("UPDATE collaboration_policy SET projection_revision=? WHERE workspace_id=? AND project_id=?",maximum-1,Long.parseLong(f.workspace()),Long.parseLong(f.project()));
        var last=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900)));
        assertAll(()->assertEquals(2,last.path("revision").asLong(-1)),()->assertEquals(maximum,last.path("projectionRevision").asLong(-1)));
        var response=request(f.owner().token(),put(f.scope(true)+"/collaboration/policy"),patch(2,Map.of("maxProjectVersions",800))).andReturn().getResponse();var result=json.readTree(response.getContentAsByteArray());var after=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(409,response.getStatus()),()->assertEquals("collaboration_policy_projection_revision_exhausted",result.path("code").asText("missing")),
            ()->assertEquals(2,after.path("revision").asLong(-1)),()->assertEquals(maximum,after.path("projectionRevision").asLong(-1)),()->assertEquals(900,row(after,"maxProjectVersions").path("local").asLong(-1)));
    }
    @Test void policyD2FirstWriteCas()throws Exception {
        var f=policyFixture();var pristine=read(f.owner(),f.scope(true));assertEquals(0,pristine.path("revision").asLong(-1));assertEquals(1,pristine.path("projectionRevision").asLong(-1));
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_policy WHERE workspace_id=? AND project_id=?",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project())));
        try(var pool=java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var start=new java.util.concurrent.CountDownLatch(1);
            var left=pool.submit(()->{start.await();return request(f.owner().token(),put(f.scope(true)+"/collaboration/policy"),patch(0,Map.of("maxProjectVersions",800))).andReturn().getResponse().getStatus();});
            var right=pool.submit(()->{start.await();return request(f.owner().token(),put(f.scope(true)+"/collaboration/policy"),patch(0,Map.of("maxProjectVersions",700))).andReturn().getResponse().getStatus();});start.countDown();
            var statuses=List.of(left.get(10,java.util.concurrent.TimeUnit.SECONDS),right.get(10,java.util.concurrent.TimeUnit.SECONDS));var after=read(f.owner(),f.scope(true));
            assertAll(()->assertThat(statuses).containsExactlyInAnyOrder(200,409),()->assertEquals(1,after.path("revision").asLong(-1)),()->assertEquals(2,after.path("projectionRevision").asLong(-1)),
                ()->assertEquals(1,jdbc.queryForObject("SELECT COUNT(*) FROM collaboration_policy WHERE workspace_id=? AND project_id=?",Long.class,Long.parseLong(f.workspace()),Long.parseLong(f.project()))),()->assertThat(row(after,"maxProjectVersions").path("local").asLong(-1)).isIn(700L,800L));
        }
    }
    @Test void policyD2ConfiguredDeploymentIsReadableNotApplied()throws Exception {
        configuredPolicy();var f=policyFixture();var view=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(67108864,row(view,"maxSourceBytes").path("effective").asLong(-1)),()->assertTrue(row(view,"maxSourceBytes").path("local").isNull()),
            ()->assertEquals("deployment",row(view,"maxSourceBytes").path("source").asText()),()->assertEquals(134217728,row(view,"rpcMaxMessageBytes").path("effective").asLong(-1)),
            ()->assertEquals(120000,row(view,"mockCallTimeoutMs").path("effective").asLong(-1)),()->assertEquals("configured",view.at("/resources/externalLimits/cpuVcpu/status").asText()),
            ()->assertEquals(new BigDecimal("1.25"),view.at("/resources/externalLimits/cpuVcpu/value").decimalValue()),()->assertEquals(1073741824,view.at("/resources/externalLimits/totalMemoryBytes/value").asLong(-1)),
            ()->assertEquals(134217728,view.at("/resources/applicationSettings/nodeHeapBytes/value").asLong(-1)),()->assertEquals(268435456,view.at("/resources/applicationSettings/inFlightBytes/value").asLong(-1)),
            ()->assertEquals(67108864,view.at("/resources/applicationSettings/headroomBytes/value").asLong(-1)),()->assertFalse(view.path("resources").has("applied")),()->assertFalse(view.path("resources").has("healthy")));
    }
    @ParameterizedTest @ValueSource(strings={"owner-get","owner-put","project-admin-get","project-admin-put","plain-get","plain-put","before-parser"})
    void policyD2PlatformManagementGuard(String branch)throws Exception {
        var f=policyFixture();var platform=platformActor();var saved=savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("maxProjectVersions",900)));assertEquals(1,saved.path("revision").asLong(-1));
        assertEquals(900,row(read(platform,PLATFORM_SCOPE),"maxProjectVersions").path("local").asLong(-1));
        Actor actor=branch.startsWith("project-admin")?f.projectAdmin():branch.startsWith("plain")?actor():f.owner();
        mvc.perform(get("/api/v1/admin/users").header("Authorization","Bearer "+actor.token())).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("superadmin_required"));
        boolean write=branch.endsWith("put")||branch.equals("before-parser");var mutation=branch.equals("before-parser")?json.createObjectNode().put("expectedRevision","bad"):patch(1,Map.of("maxProjectVersions",800));
        var response=write?request(actor.token(),put(PLATFORM_SCOPE+"/collaboration/policy"),mutation).andReturn().getResponse():mvc.perform(get(PLATFORM_SCOPE+"/collaboration/policy").header("Authorization","Bearer "+actor.token())).andReturn().getResponse();
        var result=json.readTree(response.getContentAsByteArray());var after=read(platform,PLATFORM_SCOPE);
        assertAll(()->assertEquals(403,response.getStatus()),()->assertEquals("superadmin_required",result.path("code").asText("missing")),()->assertEquals(1,after.path("revision").asLong(-1)),()->assertEquals(900,row(after,"maxProjectVersions").path("local").asLong(-1)));
    }
    @Test void policyD2PlatformUsesExistingPartialCasAndDoesNotGrantContent()throws Exception {
        var f=policyFixture();var platform=platformActor();var first=savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("maxProjectVersions",900)));assertEquals(1,first.path("revision").asLong(-1));
        var second=savePolicy(platform,PLATFORM_SCOPE,patch(1,Map.of("maxPageSize",100)));assertEquals(900,row(second,"maxProjectVersions").path("local").asLong(-1));
        request(platform.token(),put(PLATFORM_SCOPE+"/collaboration/policy"),patch(1,Map.of("maxProjectVersions",800))).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("collaboration_policy_revision_conflict"));
        mvc.perform(get(f.scope(true)+"/assets").header("Authorization","Bearer "+platform.token())).andExpect(status().isForbidden());
    }
    @Test void policyD2NumericalInheritancePreservesLocalAndActualSource()throws Exception {
        configuredPolicy();var f=policyFixture();var platform=platformActor();savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("maxProjectVersions",900)));
        var inherited=read(f.owner(),f.scope(true));
        savePolicy(f.owner(),f.scope(false),patch(0,Map.of("maxProjectVersions",800)));var workspace=read(f.owner(),f.scope(true));
        savePolicy(f.owner(),f.scope(true),patch(0,Map.of("maxProjectVersions",700)));
        savePolicy(platform,PLATFORM_SCOPE,patch(1,Map.of("maxProjectVersions",600)));var tightened=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(900,row(inherited,"maxProjectVersions").path("effective").asLong(-1)),()->assertEquals("platform",row(inherited,"maxProjectVersions").path("source").asText()),()->assertTrue(row(inherited,"maxProjectVersions").path("local").isNull()),
            ()->assertEquals(800,row(workspace,"maxProjectVersions").path("effective").asLong(-1)),()->assertEquals("workspace",row(workspace,"maxProjectVersions").path("source").asText()),()->assertTrue(row(workspace,"maxProjectVersions").path("local").isNull()),
            ()->assertEquals(700,row(tightened,"maxProjectVersions").path("local").asLong(-1)),()->assertEquals(600,row(tightened,"maxProjectVersions").path("effective").asLong(-1)),()->assertEquals("platform",row(tightened,"maxProjectVersions").path("source").asText()));
    }
    @ParameterizedTest @ValueSource(strings={"deployment","platform","workspace"})
    void policyD2ExplicitNumericCeilingRejectsWithoutClamping(String upper)throws Exception {
        configuredPolicy();var f=writeControl();var platform=platformActor();
        if(upper.equals("deployment"))bindPolicy(Map.of("defaults.max-project-versions",950));
        if(upper.equals("platform"))savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("maxProjectVersions",950)));
        if(upper.equals("workspace"))savePolicy(f.owner(),f.scope(false),patch(0,Map.of("maxProjectVersions",950)));
        var legal=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("maxProjectVersions",900)));assertEquals(900,row(legal,"maxProjectVersions").path("local").asLong(-1));
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of("maxProjectVersions",951)),400,"collaboration_policy_upper_ceiling");
    }
    @Test void policyD2ExternalSharingRequiresEachLayerExplicitAllowance()throws Exception {
        configuredPolicy();var f=policyFixture();var initial=read(f.owner(),f.scope(true));
        savePolicy(f.owner(),f.scope(false),patch(0,Map.of("externalSharingAllowed",true)));var stillClosed=read(f.owner(),f.scope(true));
        var opened=savePolicy(f.owner(),f.scope(true),patch(0,Map.of("externalSharingAllowed",true)));assertTrue(row(opened,"externalSharingAllowed").path("effective").asBoolean(false));
        var clear=patch(1,Map.of());clear.putObject("settings").putNull("externalSharingAllowed");savePolicy(f.owner(),f.scope(false),clear);var closed=read(f.owner(),f.scope(true));
        assertAll(()->assertFalse(row(initial,"externalSharingAllowed").path("effective").asBoolean(true)),()->assertFalse(row(stillClosed,"externalSharingAllowed").path("effective").asBoolean(true)),
            ()->assertTrue(row(closed,"externalSharingAllowed").path("local").asBoolean(false)),()->assertFalse(row(closed,"externalSharingAllowed").path("effective").asBoolean(true)),()->assertEquals("workspace",row(closed,"externalSharingAllowed").path("source").asText()));
    }
    @ParameterizedTest @ValueSource(strings={"externalSharingAllowed","historyPublishingAllowed","sharedMockAllowed","externalDownloadAllowed","evidenceAllowed"})
    void policyD2BooleanUpperCannotBeReopened(String field)throws Exception {
        configuredPolicy();var f=writeControl();var platform=platformActor();
        savePolicy(f.owner(),f.scope(false),patch(0,Map.of(field,true)));var permitted=savePolicy(f.owner(),f.scope(true),patch(1,Map.of(field,true)));assertTrue(row(permitted,field).path("effective").asBoolean(false));
        savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of(field,false)));var tightened=read(f.owner(),f.scope(true));
        assertAll(()->assertTrue(row(tightened,field).path("local").asBoolean(false)),()->assertFalse(row(tightened,field).path("effective").asBoolean(true)),()->assertEquals("platform",row(tightened,field).path("source").asText()),
            ()->rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of(field,true)),400,"collaboration_policy_upper_ceiling"));
    }
    @Test void policyD2SensitiveUnionIncludesAncestorsWithoutLosingLocal()throws Exception {
        configuredPolicy();bindPolicy(Map.of("defaults.extra-sensitive-fields[0]","deploymentField"));var f=policyFixture();var platform=platformActor();
        savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("extraSensitiveFields",List.of("platformField","deploymentField"))));
        savePolicy(f.owner(),f.scope(false),patch(0,Map.of("extraSensitiveFields",List.of("workspaceField","platformField"))));
        var result=savePolicy(f.owner(),f.scope(true),patch(0,Map.of("extraSensitiveFields",List.of("projectField","workspaceField"),"extraSensitivePointers",List.of(""))));
        assertAll(()->assertEquals(json.valueToTree(List.of("projectField","workspaceField")),row(result,"extraSensitiveFields").path("local")),
            ()->assertThat(row(result,"extraSensitiveFields").path("effective")).containsExactly(json.getNodeFactory().textNode("deploymentField"),json.getNodeFactory().textNode("platformField"),json.getNodeFactory().textNode("workspaceField"),json.getNodeFactory().textNode("projectField")),
            ()->assertEquals("union",row(result,"extraSensitiveFields").path("source").asText()),()->assertEquals("",row(result,"extraSensitivePointers").path("effective").path(0).asText("missing")));
    }
    @Test void policyD2SensitiveUnionCapUsesEffectiveAggregate()throws Exception {
        configuredPolicy();bindPolicy(Map.of("defaults.extra-sensitive-fields[0]","upperField"));var f=writeControl();
        var exact=java.util.stream.IntStream.range(0,199).mapToObj(i->"field"+i).toList();savePolicy(f.owner(),f.scope(true),patch(1,Map.of("extraSensitiveFields",exact)));
        var over=java.util.stream.IntStream.range(0,200).mapToObj(i->"field"+i).toList();rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of("extraSensitiveFields",over)),400,"collaboration_policy_combination_invalid");
    }
    @Test void policyD2CorsIsAnExactUpperWhitelistNotUnion()throws Exception {
        configuredPolicy();bindPolicy(Map.of("defaults.cors-allowed-origins[0]","https://one.example.test","defaults.cors-allowed-origins[1]","http://localhost:3210"));var f=writeControl();var platform=platformActor();
        savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("corsAllowedOrigins",List.of("https://one.example.test"))));
        var legal=savePolicy(f.owner(),f.scope(true),patch(1,Map.of("corsAllowedOrigins",List.of("https://one.example.test"))));assertEquals(json.valueToTree(List.of("https://one.example.test")),row(legal,"corsAllowedOrigins").path("effective"));
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of("corsAllowedOrigins",List.of("http://localhost:3210"))),400,"collaboration_policy_upper_ceiling");
    }
    @Test void policyD2CorsTighteningDoesNotExpandOrRewriteSavedLocal()throws Exception {
        configuredPolicy();bindPolicy(Map.of("defaults.cors-allowed-origins[0]","https://one.example.test","defaults.cors-allowed-origins[1]","https://two.example.test"));var f=policyFixture();var platform=platformActor();
        savePolicy(f.owner(),f.scope(true),patch(0,Map.of("corsAllowedOrigins",List.of("https://one.example.test","https://two.example.test"))));
        savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("corsAllowedOrigins",List.of("https://one.example.test"))));var view=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(2,row(view,"corsAllowedOrigins").path("local").size()),()->assertEquals(json.valueToTree(List.of("https://one.example.test")),row(view,"corsAllowedOrigins").path("effective")),()->assertEquals("platform",row(view,"corsAllowedOrigins").path("source").asText()));
    }
    @Test void policyD2LineageRetainsEveryScopeAndAncestorEpoch()throws Exception {
        configuredPolicy();var f=policyFixture();var platform=platformActor();savePolicy(platform,PLATFORM_SCOPE,patch(0,Map.of("maxProjectVersions",900)));
        savePolicy(f.owner(),f.scope(false),patch(0,Map.of("maxProjectVersions",800)));for(long i=0;i<5;i++)savePolicy(f.owner(),f.scope(true),patch(i,Map.of("maxProjectVersions",700)));
        var before=read(f.owner(),f.scope(true));var identity=before.path("identity");var lineage=identity.path("lineage");
        savePolicy(platform,PLATFORM_SCOPE,patch(1,Map.of("maxProjectVersions",650)));var after=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(3,lineage.size()),()->assertEquals("platform",lineage.path(0).path("scope").asText()),()->assertEquals(1,lineage.path(0).path("revision").asLong(-1)),
            ()->assertEquals("workspace",lineage.path(1).path("scope").asText()),()->assertEquals(f.workspace(),lineage.path(1).path("workspaceId").asText()),()->assertEquals(1,lineage.path(1).path("revision").asLong(-1)),
            ()->assertEquals("project",lineage.path(2).path("scope").asText()),()->assertEquals(f.project(),lineage.path(2).path("projectId").asText()),()->assertEquals(5,lineage.path(2).path("revision").asLong(-1)),
            ()->assertTrue(identity.path("deploymentDigest").asText().matches("[a-f0-9]{64}")),()->assertTrue(identity.path("effectiveDigest").asText().matches("[a-f0-9]{64}")),
            ()->assertNotEquals(identity,after.path("identity"),"larger child revision cannot hide ancestor change"),()->assertNotEquals(identity.path("effectiveDigest"),after.path("identity").path("effectiveDigest")));
    }
    @ParameterizedTest @ValueSource(strings={"platform","workspace"})
    void policyD2TightenRestoreBetweenReadsDoesNotRestoreIdentity(String upper)throws Exception {
        configuredPolicy();var f=policyFixture();var platform=platformActor();Actor writer=upper.equals("platform")?platform:f.owner();String target=upper.equals("platform")?PLATFORM_SCOPE:f.scope(false);
        savePolicy(writer,target,patch(0,Map.of("maxProjectVersions",900)));savePolicy(f.owner(),f.scope(true),patch(0,Map.of("maxProjectVersions",700)));
        var before=read(f.owner(),f.scope(true));savePolicy(writer,target,patch(1,Map.of("maxProjectVersions",600)));savePolicy(writer,target,patch(2,Map.of("maxProjectVersions",900)));var after=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(700,row(after,"maxProjectVersions").path("effective").asLong(-1)),()->assertEquals(before.path("identity").path("effectiveDigest"),after.path("identity").path("effectiveDigest")),
            ()->assertNotEquals(before.path("identity"),after.path("identity"),"same final settings cannot revive old ancestor epoch"));
    }
    @Test void policyD2ConfigurationIdentityIsCompleteAndNonsecret()throws Exception {
        configuredPolicy();var f=policyFixture();var before=read(f.owner(),f.scope(true));String first=before.at("/identity/deploymentDigest").asText();
        bindPolicy(Map.of("resources.cpu-vcpu","1.5"));var changed=read(f.owner(),f.scope(true));
        policyRuntime.setConnectTimeoutMs(4000);var rpc=read(f.owner(),f.scope(true));
        String oldUrl=policyRuntime.getBaseUrl(),oldFile=policyRuntime.getSecretFile();
        try{policyRuntime.setBaseUrl("https://private-"+UUID.randomUUID()+".example.test");policyRuntime.setSecretFile("synthetic-"+UUID.randomUUID());var hidden=read(f.owner(),f.scope(true));
            assertAll(()->assertTrue(first.matches("[a-f0-9]{64}"),"actual full config identity"),()->assertNotEquals(first,changed.at("/identity/deploymentDigest").asText()),
                ()->assertNotEquals(changed.at("/identity/deploymentDigest"),rpc.at("/identity/deploymentDigest")),()->assertEquals(rpc.path("identity"),hidden.path("identity")),
                ()->assertFalse(hidden.has("baseUrl")),()->assertFalse(hidden.has("secretFile")),()->assertFalse(hidden.has("secret")));
        }finally{policyRuntime.setBaseUrl(oldUrl);policyRuntime.setSecretFile(oldFile);}
    }
    @ParameterizedTest @ValueSource(strings={"cpu-low","cpu-high","rss-low","rss-high","heap-low","heap-high","negative-inflight","negative-headroom"})
    void policyD2ResourceBoundsRejectConfiguration(String branch)throws Exception {
        configuredPolicy();var f=policyFixture();var control=read(f.owner(),f.scope(true));assertEquals("configured",control.at("/resources/externalLimits/totalMemoryBytes/status").asText());
        Map<String,?> bad=switch(branch){case "cpu-low"->Map.of("resources.cpu-vcpu","0.24");case "cpu-high"->Map.of("resources.cpu-vcpu","8.01");
            case "rss-low"->Map.of("resources.total-memory-bytes",268435455);case "rss-high"->Map.of("resources.total-memory-bytes",8589934593L);
            case "heap-low"->Map.of("resources.node-heap-bytes",134217727);case "heap-high"->Map.of("resources.node-heap-bytes",4294967297L);
            case "negative-inflight"->Map.of("resources.in-flight-bytes",-1);case "negative-headroom"->Map.of("resources.headroom-bytes",-1);default->throw new IllegalArgumentException("Unexpected resource test");};
        bindPolicy(bad);mvc.perform(get(f.scope(true)+"/collaboration/policy").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isInternalServerError()).andExpect(jsonPath("$.code").value("collaboration_policy_configuration_invalid"));
    }
    @Test void policyD2ResourceSumChecksOnlyCompleteConfiguredBudgets()throws Exception {
        configuredPolicy();bindPolicy(Map.of("resources.total-memory-bytes",268435456,"resources.node-heap-bytes",134217728,"resources.in-flight-bytes",117440512,"resources.headroom-bytes",8388608));var f=policyFixture();
        var exact=read(f.owner(),f.scope(true));assertEquals(268435456,exact.at("/resources/externalLimits/totalMemoryBytes/value").asLong(-1));
        bindPolicy(Map.of("resources.in-flight-bytes",117440513));assertAll(()->assertEquals(268435456,deploymentPolicy.getResources().totalMemoryBytes()),()->assertEquals(134217728,deploymentPolicy.getResources().nodeHeapBytes()),
            ()->assertEquals(8388608,deploymentPolicy.getResources().headroomBytes()),()->assertEquals(8388608,deploymentPolicy.getDeployment().nodeCacheBytes()));
        mvc.perform(get(f.scope(true)+"/collaboration/policy").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isInternalServerError()).andExpect(jsonPath("$.code").value("collaboration_policy_configuration_invalid"));
    }
    @Test void policyD2ConfiguredMaximumsHaveLegalResourceAndBudgetPrerequisites()throws Exception {
        configuredPolicy();bindPolicy(Map.of("resources.cpu-vcpu","8","resources.total-memory-bytes",8589934592L,"resources.node-heap-bytes",4294967296L));var f=policyFixture();
        var saved=savePolicy(f.owner(),f.scope(true),patch(0,Map.of("maxSourceBytes",67108864,"maxArtifactBytes",33554432,"maxFieldBytes",65536,"maxEvidenceBytes",8388608,"maxProjectVersions",100000,"maxProjectStorageBytes",10737418240L,"maxProjectActiveGrants",10000)));
        assertAll(()->assertEquals(67108864,row(saved,"maxSourceBytes").path("effective").asLong(-1)),()->assertEquals(33554432,row(saved,"maxArtifactBytes").path("effective").asLong(-1)),()->assertEquals(10737418240L,row(saved,"maxProjectStorageBytes").path("effective").asLong(-1)),
            ()->assertEquals(new BigDecimal("8"),saved.at("/resources/externalLimits/cpuVcpu/value").decimalValue()));
    }
    @Test void policyD2ShortMockDeadlineDoesNotUseConfiguredMaximumDelay()throws Exception {
        configuredPolicy();var f=policyFixture();var saved=savePolicy(f.owner(),f.scope(true),patch(0,Map.of("maxMockDelayMs",30000,"mockCallTimeoutMs",1000)));
        assertAll(()->assertEquals(30000,row(saved,"maxMockDelayMs").path("effective").asLong(-1)),()->assertEquals(1000,row(saved,"mockCallTimeoutMs").path("effective").asLong(-1)));
    }
    @ParameterizedTest @ValueSource(strings={"storage","grants","public-rps","public-flight","mock-rps","mock-flight"})
    void policyD2DeploymentTotalsBoundCorrespondingProjectQuota(String branch)throws Exception {
        configuredPolicy();bindPolicy(Map.of("defaults.public-read-rps",1000,"defaults.public-read-in-flight",256,"defaults.mock-rps",1000,"defaults.mock-in-flight",256));var f=writeControl();
        String total,field;long limit,bad;
        switch(branch){case "storage"->{total="deployment-max-storage-bytes";field="maxProjectStorageBytes";limit=67108864;bad=67108865;}
            case "grants"->{total="deployment-max-active-grants";field="maxProjectActiveGrants";limit=50;bad=51;}
            case "public-rps"->{total="deployment-public-read-rps";field="publicReadRps";limit=100;bad=101;}
            case "public-flight"->{total="deployment-public-read-in-flight";field="publicReadInFlight";limit=64;bad=65;}
            case "mock-rps"->{total="deployment-mock-rps";field="mockRps";limit=100;bad=101;}
            case "mock-flight"->{total="deployment-mock-in-flight";field="mockInFlight";limit=64;bad=65;}
            default->throw new IllegalArgumentException("Unexpected global total test");}
        bindPolicy(Map.of("deployment."+total,limit));var legal=savePolicy(f.owner(),f.scope(true),patch(1,Map.of(field,limit)));assertEquals(limit,row(legal,field).path("local").asLong(-1));
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of(field,bad)),400,"collaboration_policy_upper_ceiling");
    }
    @ParameterizedTest @ValueSource(strings={"global-storage","cache","source-range","budget-combination","rpc-connect"})
    void policyD2ConfiguredPolicyValidationHasActualReadBoundary(String branch)throws Exception {
        configuredPolicy();var f=policyFixture();var control=read(f.owner(),f.scope(true));assertEquals(67108864,row(control,"maxSourceBytes").path("effective").asLong(-1));
        switch(branch){case "global-storage"->bindPolicy(Map.of("deployment.deployment-max-storage-bytes",67108863));case "cache"->bindPolicy(Map.of("deployment.node-cache-bytes",8388607));
            case "source-range"->bindPolicy(Map.of("defaults.max-source-bytes",67108865));case "budget-combination"->bindPolicy(Map.of("defaults.max-artifact-bytes",65536,"defaults.max-field-bytes",256,"defaults.max-evidence-bytes",131072));
            case "rpc-connect"->policyRuntime.setConnectTimeoutMs(99);default->throw new IllegalArgumentException("Unexpected configured setting test");}
        mvc.perform(get(f.scope(true)+"/collaboration/policy").header("Authorization","Bearer "+f.owner().token())).andExpect(status().isInternalServerError()).andExpect(jsonPath("$.code").value("collaboration_policy_configuration_invalid"));
    }
    @ParameterizedTest @ValueSource(strings={"share","page"})
    void policyD2ChoiceEffectiveMaximumRejectsNewDefault(String branch)throws Exception {
        var f=writeControl();boolean share=branch.equals("share");String choice=share?"defaultShareDurationMs":"defaultPageSize",maximum=share?"maxShareDurationMs":"maxPageSize";
        long upperDefault=share?60000:50,upperMax=share?120000:100,childDefault=share?90000:75;
        var upper=savePolicy(f.owner(),f.scope(false),patch(0,Map.of(choice,upperDefault,maximum,upperMax)));assertEquals(upperMax,row(upper,maximum).path("effective").asLong(-1));
        var legal=savePolicy(f.owner(),f.scope(true),patch(1,Map.of(choice,childDefault)));assertEquals(childDefault,row(legal,choice).path("effective").asLong(-1));
        rejectPolicyWrite(f,f.owner(),f.scope(true),patch(2,Map.of(choice,upperMax+1)),400,"collaboration_policy_combination_invalid");
    }
    @ParameterizedTest @ValueSource(strings={"share","page"})
    void policyD2ChoiceExistingDefaultIsConstrainedWithoutChangingLocal(String branch)throws Exception {
        var f=writeControl();boolean share=branch.equals("share");String choice=share?"defaultShareDurationMs":"defaultPageSize",maximum=share?"maxShareDurationMs":"maxPageSize";
        long upperDefault=share?60000:50,upperMax=share?120000:100,childDefault=share?90000:75,tightenedMax=share?60000:60;
        savePolicy(f.owner(),f.scope(false),patch(0,Map.of(choice,upperDefault,maximum,upperMax)));
        var legal=savePolicy(f.owner(),f.scope(true),patch(1,Map.of(choice,childDefault)));assertEquals(childDefault,row(legal,choice).path("effective").asLong(-1));
        savePolicy(f.owner(),f.scope(false),patch(1,Map.of(maximum,tightenedMax)));var after=read(f.owner(),f.scope(true));
        assertAll(()->assertEquals(childDefault,row(after,choice).path("local").asLong(-1)),()->assertEquals(tightenedMax,row(after,choice).path("effective").asLong(-1)),()->assertEquals("workspace",row(after,choice).path("source").asText()));
    }
}
