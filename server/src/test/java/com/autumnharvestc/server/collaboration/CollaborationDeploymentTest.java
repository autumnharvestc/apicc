package com.autumnharvestc.server.collaboration;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class CollaborationDeploymentTest extends CollaborationApiFixture {
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.publicapi.PublicAccessProperties publicSettings;
    @Test void n1SchemelessOptionalManagementOriginIsHiddenWithoutCrashingRead()throws Exception {
        var admin=login("admin","admin-pass-2026");var oldBase=publicSettings.getBaseUrl();var oldManagement=publicSettings.getManagementBaseUrl();var oldEnabled=publicSettings.isEnabled();
        try{publicSettings.setEnabled(true);publicSettings.setBaseUrl("http://127.0.0.1:9081");publicSettings.setManagementBaseUrl("https://management.example.test");
            var valid=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
            assertAll(()->assertTrue(valid.at("/publicAccess/originConfigured").asBoolean()),()->assertEquals("https://management.example.test",valid.at("/publicAccess/managementBaseUrl").asText()));
            publicSettings.setManagementBaseUrl("//management.example.test");
            var response=assertDoesNotThrow(()->mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()),"invalid optional origin must not crash deployment metadata");
            var invalid=body(response);
            assertAll(()->assertTrue(invalid.at("/publicAccess/managementBaseUrl").isNull()),()->assertEquals("invalid-origin",invalid.at("/publicAccess/managementOriginStatus").asText()),()->assertFalse(invalid.toString().contains("//management.example.test")));
        }finally{publicSettings.setEnabled(oldEnabled);publicSettings.setBaseUrl(oldBase);publicSettings.setManagementBaseUrl(oldManagement);}
    }
    @Test void n1SchemelessDisabledPublicOriginIsHiddenWithoutCrashingRead()throws Exception {
        var admin=login("admin","admin-pass-2026");var oldBase=publicSettings.getBaseUrl();var oldManagement=publicSettings.getManagementBaseUrl();var oldEnabled=publicSettings.isEnabled();
        try{publicSettings.setEnabled(false);publicSettings.setBaseUrl("https://public.example.test");publicSettings.setManagementBaseUrl("https://management.example.test");
            var valid=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
            assertAll(()->assertFalse(valid.at("/publicAccess/enabled").asBoolean(true)),()->assertEquals("https://public.example.test",valid.at("/publicAccess/baseUrl").asText()),()->assertTrue(valid.at("/publicAccess/originConfigured").asBoolean()));
            publicSettings.setBaseUrl("//public.example.test");
            var response=assertDoesNotThrow(()->mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()),"invalid disabled saved origin must not crash deployment metadata");
            var invalid=body(response);
            assertAll(()->assertFalse(invalid.at("/publicAccess/enabled").asBoolean(true)),()->assertTrue(invalid.at("/publicAccess/baseUrl").isNull()),()->assertFalse(invalid.at("/publicAccess/originConfigured").asBoolean(true)),()->assertEquals("invalid-origin-or-separation",invalid.at("/publicAccess/originStatus").asText()),()->assertFalse(invalid.toString().contains("//public.example.test")));
        }finally{publicSettings.setEnabled(oldEnabled);publicSettings.setBaseUrl(oldBase);publicSettings.setManagementBaseUrl(oldManagement);}
    }
    @org.junit.jupiter.api.Test void i6InvalidOptionalManagementOriginIsNotDisclosed()throws Exception {
        var admin=login("admin","admin-pass-2026");var oldBase=publicSettings.getBaseUrl();var oldManagement=publicSettings.getManagementBaseUrl();var oldEnabled=publicSettings.isEnabled();
        try{publicSettings.setEnabled(true);publicSettings.setBaseUrl("http://127.0.0.1:9081");publicSettings.setManagementBaseUrl("https://management.example.test");
            var valid=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));assertEquals("https://management.example.test",valid.at("/publicAccess/managementBaseUrl").asText());
            publicSettings.setManagementBaseUrl("https://user:PRIVATE_PASSWORD@management.example.test");
            var invalid=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
            assertAll(()->assertFalse(invalid.toString().contains("PRIVATE_PASSWORD")),()->assertTrue(invalid.at("/publicAccess/managementBaseUrl").isNull()),()->assertEquals("invalid-origin",invalid.at("/publicAccess/managementOriginStatus").asText()));
        }finally{publicSettings.setEnabled(oldEnabled);publicSettings.setBaseUrl(oldBase);publicSettings.setManagementBaseUrl(oldManagement);}
    }
    @org.junit.jupiter.api.Test void i6ExistingAdmissionOriginRulesRemainIndependent() {
        var p=new com.autumnharvestc.server.collaboration.publicapi.PublicAccessProperties();p.setEnabled(true);p.setBaseUrl("http://127.0.0.1:9081");assertTrue(p.configured(8080));
        p.setEnabled(false);assertFalse(p.configured(8080));p.setEnabled(true);
        for(var raw:java.util.List.of("http://remote.example.test","http://127.0.0.1:8080","https://user:password@public.example.test","https://public.example.test/path","https://public.example.test?q=secret","https://public.example.test#secret")){p.setBaseUrl(raw);assertFalse(p.configured(8080),raw);}
        p.setBaseUrl("https://public.example.test");assertFalse(p.configured(8080));p.setManagementBaseUrl("https://public.example.test");assertFalse(p.configured(8080));p.setManagementBaseUrl("https://management.example.test");assertTrue(p.configured(8080));
    }
    @org.junit.jupiter.api.Test void i6SavedOriginsRemainReadableWhenListenerDisabled()throws Exception {
        var admin=login("admin","admin-pass-2026");var oldBase=publicSettings.getBaseUrl();var oldManagement=publicSettings.getManagementBaseUrl();var oldEnabled=publicSettings.isEnabled();
        try{publicSettings.setEnabled(false);publicSettings.setBaseUrl("https://public.example.test");publicSettings.setManagementBaseUrl("https://management.example.test");
            var view=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
            assertAll(()->assertFalse(view.at("/publicAccess/enabled").asBoolean(true)),()->assertEquals("https://public.example.test",view.at("/publicAccess/baseUrl").asText()),()->assertEquals("https://management.example.test",view.at("/publicAccess/managementBaseUrl").asText()),()->assertTrue(view.at("/publicAccess/originConfigured").asBoolean()),()->assertEquals("valid",view.at("/publicAccess/originStatus").asText()));
            assertFalse(publicSettings.configured(8080),"actual admission still requires enabled");
        }finally{publicSettings.setEnabled(oldEnabled);publicSettings.setBaseUrl(oldBase);publicSettings.setManagementBaseUrl(oldManagement);}
    }
    @org.junit.jupiter.api.Test void i7ResourcesExposeActualReadOnlyDefaultsRangesAndBudgetRelationship()throws Exception {
        var admin=login("admin","admin-pass-2026");var view=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
        var rows=view.path("resources");assertAll(()->assertEquals(6,rows.size()),()->assertEquals("externalLimits.cpuVcpu",rows.path(0).path("code").asText()),()->assertEquals(0.25,rows.path(0).path("minimum").asDouble(-1)),()->assertEquals(8,rows.path(0).path("maximum").asInt(-1)),()->assertTrue(rows.path(0).path("defaultValue").isNull()),()->assertEquals(268435456,rows.path(1).path("minimum").asLong(-1)),()->assertEquals(8589934592L,rows.path(1).path("maximum").asLong(-1)),()->assertEquals(134217728,rows.path(2).path("minimum").asLong(-1)),()->assertEquals(4294967296L,rows.path(2).path("maximum").asLong(-1)),()->assertEquals(0,rows.path(3).path("minimum").asLong(-1)),()->assertTrue(rows.path(3).path("maximum").isNull()),()->assertEquals(67108864,rows.path(5).path("defaultValue").asLong(-1)),()->assertEquals(8388608,rows.path(5).path("minimum").asLong(-1)),()->assertEquals("bytes",rows.path(5).path("unit").asText()),()->assertEquals("runtime-startup",rows.path(5).path("effect").asText()),()->assertEquals("heap-cache-inflight-headroom-within-total",view.path("resourceConstraint").asText()));
    }
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.runtime.RuntimeProperties runtime;
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans={false,true})
    void t10EnabledConfigurationDoesNotClaimCheckedRuntimeHealth(boolean configured)throws Exception {
        var admin=login("admin","admin-pass-2026");
        var before=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
        assertEquals("disabled",before.at("/runtime/health").asText());
        String oldEndpoint=runtime.getBaseUrl(),oldSecret=runtime.getSecretFile();boolean oldEnabled=runtime.isEnabled();
        try {
            runtime.setEnabled(true);runtime.setBaseUrl(configured?"https://private-runtime.example.test":"");runtime.setSecretFile(configured?"PRIVATE_SECRET_PATH_DO_NOT_DISCLOSE":"");
            var view=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
            assertAll(
                ()->assertEquals(configured?"unchecked":"unconfigured",view.at("/runtime/health").asText()),
                ()->assertFalse(view.toString().contains("PRIVATE_SECRET_PATH_DO_NOT_DISCLOSE")),
                ()->assertFalse(view.toString().contains("private-runtime.example.test"))
            );
        } finally {runtime.setEnabled(oldEnabled);runtime.setBaseUrl(oldEndpoint);runtime.setSecretFile(oldSecret);}
    }
    static final String URL="/api/v1/admin/collaboration/deployment";
    @Test void t10DisplaysActualDisabledRuntimeAndUnboundListenerWithoutInferringHealth()throws Exception {
        var admin=login("admin","admin-pass-2026");
        mvc.perform(get("/api/v1/admin/collaboration/policy").header("Authorization","Bearer "+admin)).andExpect(status().isOk());
        var view=body(mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk()));
        assertAll(
            ()->assertEquals("disabled",view.at("/runtime/health").asText("missing")),
            ()->assertEquals(1,view.at("/runtime/expectedProtocolVersion").asInt(-1)),
            ()->assertTrue(view.at("/publicAccess/boundPort").isNull(),"actual absent listener port"),
            ()->assertEquals("boolean",view.at("/fields/0/unit").asText("missing")),
            ()->assertEquals("deployment",view.at("/fields/0/source").asText("missing")),
            ()->assertEquals("restart-required",view.at("/fields/0/effect").asText("missing"))
        );
    }
    @Test void t10DeploymentReadUsesExistingSuperadminAuthority()throws Exception {
        var admin=login("admin","admin-pass-2026");
        mvc.perform(get(URL).header("Authorization","Bearer "+admin)).andExpect(status().isOk());
        var ordinary=actor();
        mvc.perform(get(URL).header("Authorization","Bearer "+ordinary.token())).andExpect(status().isForbidden());
    }
}
