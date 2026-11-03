package com.autumnharvestc.server.collaboration;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:apicc-collaboration-t7-origin;DB_CLOSE_DELAY=-1",
    "server.address=127.0.0.1", "apicc.collaboration.policy.defaults.external-sharing-allowed=true",
    "apicc.collaboration.public-access.enabled=true", "apicc.collaboration.public-access.port=0",
    "apicc.collaboration.public-access.base-url=http://127.0.0.1:18792"})
class PublicOriginBoundaryTest extends GrantHttpFixture {
    static final int PUBLIC_PORT=loopbackPort();
    @LocalServerPort int managementPort;
    static final java.nio.file.Path console=console();
    static java.nio.file.Path console(){try{var dir=java.nio.file.Files.createTempDirectory("t7-synthetic-console-");java.nio.file.Files.createDirectories(dir.resolve("assets"));java.nio.file.Files.writeString(dir.resolve("index.html"),"<html>ADMIN_CONSOLE_T7</html>");java.nio.file.Files.writeString(dir.resolve("assets/app.js"),"/* ADMIN_BUNDLE_T7 */");return dir;}catch(Exception failure){throw new IllegalStateException(failure);}}
    static java.nio.file.Path viewer(){var directory=java.nio.file.Path.of("").toAbsolutePath();if(directory.endsWith("server"))directory=directory.getParent();return directory.resolve("apps/share-viewer/dist");}
    @DynamicPropertySource static void console(DynamicPropertyRegistry properties){properties.add("apicc.server.console-dir",()->console.toString());properties.add("apicc.collaboration.public-access.viewer-dir",()->viewer().toString());properties.add("apicc.collaboration.public-access.port",()->PUBLIC_PORT);properties.add("apicc.collaboration.public-access.base-url",()->"http://127.0.0.1:"+PUBLIC_PORT);}

    @Test void configuredPublicListenerHasRealFixedBodyAndNoNodeDependency()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));
        rpc.unavailable=true;readable(grant);
        assertThat(listener.origin()).isNotEqualTo("http://127.0.0.1:"+managementPort);
    }
    @ParameterizedTest @ValueSource(strings={"/api/v1/ping","/api/v1/workspaces","/assets/app.js","/workspaces","/"})
    void publicListenerNeverHostsAdminApiResourcesOrFallback(String path)throws Exception {
        var admin=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+managementPort+"/assets/app.js")).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(admin.statusCode()).isEqualTo(200);assertThat(admin.body()).contains("ADMIN_BUNDLE_T7");
        var response=readPath(path,"X-Apicc-Share-Key",null,null);
        assertAll(()->assertThat(response.statusCode()).isEqualTo(404),()->assertThat(response.body()).doesNotContain("ADMIN_CONSOLE_T7","ADMIN_BUNDLE_T7"),()->assertThat(response.headers().allValues("Set-Cookie")).isEmpty());
    }
    @ParameterizedTest @ValueSource(strings={"/s/synthetic","/share-api/synthetic","/mock/synthetic/path","/share-viewer","/share-viewer/deep-link"})
    void managementListenerRejectsPublicRoutesBeforeConsoleFallback(String path)throws Exception {
        var control=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+managementPort+"/workspaces")).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(control.statusCode()).isEqualTo(200);assertThat(control.body()).contains("ADMIN_CONSOLE_T7");
        var response=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+managementPort+path)).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(404);assertThat(response.body()).doesNotContain("ADMIN_CONSOLE_T7");
    }
    @Test void fixedShellCarriesStrictHeadersWithoutSecretOrCookie()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));
        var response=readPath("/s/"+grant.path("publicId").asText(),"X-Apicc-Share-Key",null,null);
        assertThat(response.statusCode()).isEqualTo(200);
        assertAll(()->assertThat(response.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store"),
            ()->assertThat(response.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff"),
            ()->assertThat(response.headers().firstValue("Referrer-Policy").orElse("")).isEqualTo("no-referrer"),
            ()->assertThat(response.headers().firstValue("Content-Security-Policy").orElse("")).contains("default-src 'none'","frame-ancestors 'none'"),
            ()->assertThat(response.headers().allValues("Set-Cookie")).isEmpty(),()->assertThat(response.body()).doesNotContain(grant.path("key").asText()));
    }
    @Test void viewerShellAndItsActualFixedBuildResourcesAreSeparateFromConsole()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));
        var response=readPath("/s/"+grant.path("publicId").asText(),"X-Apicc-Share-Key",null,null);
        assertThat(response.statusCode()).isEqualTo(200);
        assertAll(()->assertThat(response.body()).contains("/share-viewer/viewer.js","/share-viewer/viewer.css","id=\"app\""),
            ()->assertThat(response.body()).doesNotContain("ADMIN_CONSOLE_T7"),
            ()->assertThat(response.headers().firstValue("Content-Security-Policy").orElse("")).contains("script-src ","/share-viewer/viewer.js","style-src ","/share-viewer/viewer.css","connect-src 'self'","default-src 'none'","frame-ancestors 'none'").doesNotContain("unsafe-inline","unsafe-eval","sandbox"));
        for(String path:List.of("/share-viewer/viewer.js","/share-viewer/viewer.css")){
            var resource=readPath(path,"X-Apicc-Share-Key",null,null);
            assertAll(()->assertThat(resource.statusCode()).isEqualTo(200),
                ()->assertThat(resource.body()).doesNotContain("ADMIN_BUNDLE_T7"),
                ()->assertThat(resource.headers().firstValue("Content-Type").orElse("")).contains(path.endsWith(".js")?"javascript":"text/css"),
                ()->assertThat(resource.headers().firstValue("Cache-Control").orElse("")).isEqualTo("no-store"),
                ()->assertThat(resource.headers().firstValue("X-Content-Type-Options").orElse("")).isEqualTo("nosniff"),
                ()->assertThat(resource.headers().firstValue("Referrer-Policy").orElse("")).isEqualTo("no-referrer"),
                ()->assertThat(resource.headers().allValues("Set-Cookie")).isEmpty());
            assertThat(resource.body()).isNotBlank();
            var management=http.send(java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:"+managementPort+path)).GET().build(),java.net.http.HttpResponse.BodyHandlers.ofString());
            assertThat(management.statusCode()).isEqualTo(404);assertThat(management.body()).doesNotContain("ADMIN_CONSOLE_T7");
        }
    }
    @Test void authorizedReadMetadataControlsRealFreshDownloadAndNeverReturnsKeys()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var grant=createGrant(f,publication,grantCommand("view","external"));
        var read=read(grant,grant.path("key").asText());
        assertAll(()->assertThat(read.statusCode()).isEqualTo(200),()->assertThat(read.headers().firstValue("X-Apicc-Download-Allowed").orElse("")).isEqualTo("false"),()->assertThat(read.headers().firstValue("X-Apicc-Publication-Version").orElse("")).isEqualTo("1"));
        result(readPath("/share-api/"+grant.path("publicId").asText()+"/download","X-Apicc-Share-Key",grant.path("key").asText(),null),404,"share_unavailable");
    }
    @ParameterizedTest @ValueSource(strings={"/share-viewer/viewer.js","/share-viewer/viewer.css"})
    void actualViewerAssetsHaveExecutableTypesAndNonemptyBodies(String path)throws Exception {
            var resource=readPath(path,"X-Apicc-Share-Key",null,null);
            assertAll(()->assertThat(resource.statusCode()).isEqualTo(200),()->assertThat(resource.headers().firstValue("Content-Type").orElse("")).contains(path.endsWith(".js")?"javascript":"text/css"),()->assertThat(resource.body()).isNotBlank());
    }
    @Test void enabledDownloadMetadataMatchesIndependentlyAuthorizedSafeJsonTransport()throws Exception {
        var f=fixture();var publication=fixedDocument(f);var previous=deployment.getDefaults();
        try{
            deployment.setDefaults(json.convertValue(Map.of("externalSharingAllowed",true,"externalDownloadAllowed",true),com.autumnharvestc.server.collaboration.policy.DeploymentPolicyProperties.Defaults.class));
            policy(f,true,Map.of("externalDownloadAllowed",true));policy(f,false,Map.of("externalDownloadAllowed",true));
            var grant=createGrant(f,publication,grantCommand("view","external").put("downloadAllowed",true));
            var read=read(grant,grant.path("key").asText());
            assertThat(read.statusCode()).isEqualTo(200);
            var download=readPath("/share-api/"+grant.path("publicId").asText()+"/download","X-Apicc-Share-Key",grant.path("key").asText(),null);
            assertAll(()->assertThat(read.headers().firstValue("X-Apicc-Download-Allowed").orElse("")).isEqualTo("true"),()->assertThat(download.statusCode()).isEqualTo(200),()->assertThat(download.headers().firstValue("Content-Type").orElse("")).contains("application/json"),()->assertThat(download.headers().firstValue("X-Apicc-Download-Allowed").orElse("")).isEqualTo("true"));
            assertThat(json.readTree(download.body()).path("kind").asText()).isEqualTo("document");
            assertThat(download.body().contains(grant.path("key").asText())).isFalse();
            request(f.owner().token(),patch(collaboration(f)+"/publications/"+publication.path("id").asText()),Map.of("expectedRevision",1,"enabled",false)).andExpect(status().isOk());
            inactive(readPath("/share-api/"+grant.path("publicId").asText()+"/download","X-Apicc-Share-Key",grant.path("key").asText(),null),"publication_disabled");
        }finally{deployment.setDefaults(previous);}
    }
    @ParameterizedTest @ValueSource(strings={"/share-viewer/other.js","/share-viewer/index.html","/share-viewer/package.json","/share-viewer/../application.yml","/share-viewer/%2e%2e/application.yml"})
    void onlyFixedViewerAssetsAreServedWithNoTraversalOrSpaFallback(String path)throws Exception {
        result(readPath(path,"X-Apicc-Share-Key",null,null),404,"share_unavailable");
    }
    @Test void viewerAssetMethodsCannotBecomeAnUnintendedWrite()throws Exception {
        var request=java.net.http.HttpRequest.newBuilder(java.net.URI.create(listener.origin()+"/share-viewer/viewer.js")).POST(java.net.http.HttpRequest.BodyPublishers.noBody()).build();
        result(http.send(request,java.net.http.HttpResponse.BodyHandlers.ofString()),404,"share_unavailable");
    }
    @Test void missingExplicitViewerDirectoryNeverFallsBackToConsoleOrPartialSuccess()throws Exception {
        var previous=publicSettings.getViewerDir();var empty=java.nio.file.Files.createTempDirectory("t11-missing-viewer-");
        try{
            publicSettings.setViewerDir(empty.toString());
            assertAll(()->result(readPath("/s/"+"a".repeat(22),"X-Apicc-Share-Key",null,null),503,"share_viewer_unavailable"),
                ()->result(readPath("/share-viewer/viewer.js","X-Apicc-Share-Key",null,null),503,"share_viewer_unavailable"));
        }finally{publicSettings.setViewerDir(previous);}
    }
    @ParameterizedTest @ValueSource(strings={"index.html","viewer.js","viewer.css"})
    void partialExplicitViewerCannotYieldASuccessfulShell(String missing)throws Exception {
        var previous=publicSettings.getViewerDir();var dir=java.nio.file.Files.createTempDirectory("t11-incomplete-viewer-");
        for(String name:List.of("index.html","viewer.js","viewer.css"))if(!name.equals(missing))java.nio.file.Files.writeString(dir.resolve(name),"synthetic fixed viewer resource");
        try{publicSettings.setViewerDir(dir.toString());result(readPath("/s/"+"a".repeat(22),"X-Apicc-Share-Key",null,null),503,"share_viewer_unavailable");}
        finally{publicSettings.setViewerDir(previous);}
    }
    @ParameterizedTest @ValueSource(strings={"disabled","empty","invalid"}) void publicConfigurationDoesNotOpenExternalGrantByDefault(String branch)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var old=publicSettings.getBaseUrl();boolean enabled=publicSettings.isEnabled();
        try{
            if(branch.equals("disabled"))publicSettings.setEnabled(false);else publicSettings.setBaseUrl(branch.equals("empty")?"":"http://127.0.0.1:18792/untrusted-path");
            publication(f,f.owner(),publication.path("id").asText());
            request(f.owner().token(),post(createPath(f,publication)),grantCommand("view","external"))
                .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("public_origin_unavailable"));
        }finally{publicSettings.setBaseUrl(old);publicSettings.setEnabled(enabled);}
    }
    @Test void configuredOriginWinsOverHostAndForwardedHeaders()throws Exception {
        var f=fixture();var publication=fixedDocument(f);
        var grant=body(request(f.owner().token(),post(createPath(f,publication)).header("Host","attacker.invalid").header("X-Forwarded-Host","attacker.invalid").header("X-Forwarded-Proto","https"),grantCommand("view","external")).andExpect(status().isCreated()));
        assertThat(grant.path("publicUrl").asText()).startsWith("http://127.0.0.1:"+PUBLIC_PORT+"/s/").doesNotContain("attacker");
    }
    @ParameterizedTest @ValueSource(strings={"same-local-origin","remote-http","https-without-management-origin","same-proxy-origin"})
    void originMustBeSeparateAndHttpsForRemoteDeployment(String branch)throws Exception {
        var f=fixture();var publication=fixedDocument(f);var old=publicSettings.getBaseUrl();var admin=publicSettings.getManagementBaseUrl();
        try{
            switch(branch){
                case "same-local-origin"->publicSettings.setBaseUrl("http://127.0.0.1:"+managementPort);
                case "remote-http"->publicSettings.setBaseUrl("http://public.invalid");
                case "https-without-management-origin"->{publicSettings.setBaseUrl("https://public.invalid");publicSettings.setManagementBaseUrl("");}
                case "same-proxy-origin"->{publicSettings.setBaseUrl("https://public.invalid");publicSettings.setManagementBaseUrl("https://public.invalid");}
            }
            request(f.owner().token(),post(createPath(f,publication)),grantCommand("view","external")).andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("public_origin_unavailable"));
        }finally{publicSettings.setBaseUrl(old);publicSettings.setManagementBaseUrl(admin);}
    }
}
