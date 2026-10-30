package com.autumnharvestc.server.execution;

import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import com.autumnharvestc.server.execution.scheduling.NotificationProperties;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@org.springframework.test.context.TestPropertySource(properties="spring.datasource.url=jdbc:h2:mem:apicc-t5-channels;DB_CLOSE_DELAY=-1")
class NotificationChannelsTest extends ScheduleFixture {
    @org.springframework.test.context.bean.override.mockito.MockitoBean com.autumnharvestc.server.execution.notifications.NotificationTimer notificationTimer;
    @Autowired NotificationProperties outbound;
    String channels(F f){return "/api/v1/workspaces/"+f.ws()+"/notification-channels";}
    Map<String,Object> channel(){return new LinkedHashMap<>(Map.of("expectedVersion","0","name","合成接收端","url","https://hook.example.test/private?key=synthetic-url-secret","hmacSecret","synthetic-hmac-secret","enabled",true));}
    static java.util.stream.Stream<org.junit.jupiter.params.provider.Arguments> canonicalOrigins(){return java.util.stream.Stream.of(
        org.junit.jupiter.params.provider.Arguments.of("host-case","https://HOOK.example.test/MiXeD%2fPath?Case=%2F&A=b","https://hook.example.test"),
        org.junit.jupiter.params.provider.Arguments.of("https-default","https://HOOK.example.test:443/MiXeD%2fPath?Case=%2F&A=b","https://hook.example.test"),
        org.junit.jupiter.params.provider.Arguments.of("http-default","http://HOOK.example.test:80/MiXeD%2fPath?Case=%2F&A=b","http://hook.example.test"),
        org.junit.jupiter.params.provider.Arguments.of("ipv6-loopback","https://[0:0:0:0:0:0:0:1]:443/MiXeD%2fPath?Case=%2F&A=b","https://[::1]"),
        org.junit.jupiter.params.provider.Arguments.of("ipv6-tie","https://[2001:0DB8:0:0:1:0:0:1]:9443/MiXeD%2fPath?Case=%2F&A=b","https://[2001:db8::1:0:0:1]:9443"),
        org.junit.jupiter.params.provider.Arguments.of("ipv6-mapped","https://[::ffff:127.0.0.1]/MiXeD%2fPath?Case=%2F&A=b","https://[::ffff:7f00:1]"),
        org.junit.jupiter.params.provider.Arguments.of("ipv6-zero","https://[0:0:0:0:0:0:0:0]/path","https://[::]"),
        org.junit.jupiter.params.provider.Arguments.of("ipv6-tail","https://[2001:DB8:0:0:0:0:0:0]/path","https://[2001:db8::]"),
        org.junit.jupiter.params.provider.Arguments.of("ipv6-single","https://[2001:db8:0:1:2:3:4:5]/path","https://[2001:db8:0:1:2:3:4:5]"),
        org.junit.jupiter.params.provider.Arguments.of("ipv4-standard","https://127.0.0.1/path","https://127.0.0.1"));}
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.MethodSource("canonicalOrigins")
    void createsAndListsCanonicalOriginsWithoutRewritingEncryptedUrl(String kind,String url,String canonical)throws Exception{
        var f=fixture();var input=channel();input.put("url",url);var created=body(member(f,post(channels(f)),input).andExpect(status().isCreated()));
        var page=body(member(f,get(channels(f)),Map.of()).andExpect(status().isOk()));wire("t5-r1-origin-"+kind,json.createObjectNode().set("items",json.createArrayNode().add(created)));wire("t5-r1-origin-list-"+kind,page);
        assertThat(created.path("origin").asText()).isEqualTo(canonical);assertThat(page.path("items").findValuesAsText("origin")).contains(canonical);
        long id=Long.parseLong(created.path("id").asText());assertThat(channelRows.find(Long.parseLong(f.ws()),id,false).orElseThrow().origin()).isEqualTo(canonical);
        var material=channelCipher.open(channelRows.find(Long.parseLong(f.ws()),id,false).orElseThrow());try{assertThat(material.uri().toString()).isEqualTo(url);}finally{Arrays.fill(material.hmacSecret(),(byte)0);}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.MethodSource("canonicalOrigins")
    void updatesCanonicalOriginWithoutRewritingEncryptedUrl(String kind,String url,String canonical)throws Exception{
        var f=fixture();String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();
        var updated=body(member(f,put(channels(f)+"/"+id),Map.of("expectedVersion","1","url",url)).andExpect(status().isOk()));assertThat(updated.path("origin").asText()).isEqualTo(canonical);
        var material=channelCipher.open(channelRows.find(Long.parseLong(f.ws()),Long.parseLong(id),false).orElseThrow());try{assertThat(material.uri().toString()).isEqualTo(url);}finally{Arrays.fill(material.hmacSecret(),(byte)0);}
    }
    @Test void previouslyStoredMixedCaseOriginCanStillBeListedByStrictClients()throws Exception{
        var f=fixture();String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();jdbc.update("UPDATE execution_notification_channels SET origin='https://HOOK.example.test:443' WHERE id=?",Long.valueOf(id));
        assertThat(body(member(f,get(channels(f)),Map.of()).andExpect(status().isOk())).path("items").findValuesAsText("origin")).doesNotContain("https://HOOK.example.test:443").contains("https://hook.example.test");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"https://hook.example.test:65536/path","https://hook.example.test:0/path","https://127.1/path","https://0177.0.0.1/path","https://0x7f000001/path","https://hook.123/path","https://[fe80::1%25private]/path","https://[::ffff:127.00.0.1]/path","https://127.0.0.1./path","https://xn--a.test/path","https://XN--BCHER-KVA.test/path","https://bücher.test/path"})
    void rejectsUnsupportedOriginRepresentationsBeforeInsertOrUpdate(String url)throws Exception{
        var f=fixture();var input=channel();input.put("url",url);long before=jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_channels",Long.class);member(f,post(channels(f)),input).andExpect(status().isBadRequest());assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_channels",Long.class)).isEqualTo(before);
        String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();member(f,put(channels(f)+"/"+id),Map.of("expectedVersion","1","url",url)).andExpect(status().isBadRequest());assertThat(channelRows.find(Long.parseLong(f.ws()),Long.parseLong(id),false).orElseThrow().version()).isEqualTo(1);
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"https://xn--a.test","https://xn--bcher-kva.test","https://hook.example.test:65536"})
    void legacyUnsupportedOriginIsAnUnavailableManageableRowRatherThanABrokenList(String oldOrigin)throws Exception{
        var f=fixture();String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();jdbc.update("UPDATE execution_notification_channels SET origin=? WHERE id=?",oldOrigin,Long.valueOf(id));
        var page=body(member(f,get(channels(f)),Map.of()).andExpect(status().isOk()));var row=page.path("items").findValues("id").isEmpty()?json.nullNode():java.util.stream.StreamSupport.stream(page.path("items").spliterator(),false).filter(r->r.path("id").asText().equals(id)).findFirst().orElseThrow();
        assertThat(row.path("origin").isNull()).isTrue();assertThat(row.path("status").asText()).isEqualTo("unavailable");assertThat(row.path("version").asText()).isEqualTo("1");wire("t5-r1-legacy-unsupported",row);
        assertThat(body(member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk())).path("channels").findValuesAsText("id")).doesNotContain(id);
        member(f,put(channels(f)+"/"+id),Map.of("expectedVersion","1","enabled",false)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("disabled"));
    }
    @Test void workspaceOwnerCanStoreEncryptedChannelAndMetadataNeverReturnsSecrets()throws Exception{
        var f=fixture();var old=outbound.getAllowedWebhookOrigins();
        try{outbound.setAllowedWebhookOrigins(List.of("https://hook.example.test"));
            var saved=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated()));
            var stored=jdbc.queryForMap("SELECT nonce,ciphertext FROM execution_notification_channels WHERE id=?",Long.valueOf(saved.path("id").asText()));
            assertThat((byte[])stored.get("nonce")).hasSize(12);assertThat(new String((byte[])stored.get("ciphertext"),java.nio.charset.StandardCharsets.UTF_8)).doesNotContain("synthetic-url-secret","synthetic-hmac-secret");
            var cipher=javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");cipher.init(javax.crypto.Cipher.DECRYPT_MODE,new javax.crypto.spec.SecretKeySpec(java.nio.file.Files.readAllBytes(KEY),"AES"),new javax.crypto.spec.GCMParameterSpec(128,(byte[])stored.get("nonce")));cipher.updateAAD(("notification/v1/"+f.ws()+"/"+saved.path("id").asText()+"/1").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            var plain=json.readTree(cipher.doFinal((byte[])stored.get("ciphertext")));assertThat(plain.path("url").asText()).isEqualTo("https://hook.example.test/private?key=synthetic-url-secret");assertThat(plain.path("hmacSecret").asText()).isEqualTo("synthetic-hmac-secret");
            assertThat(saved.path("version").asText()).isEqualTo("1");assertThat(saved.path("kind").asText()).isEqualTo("webhook");assertThat(saved.path("status").asText()).isEqualTo("available");
            var metadata=body(member(f,get(channels(f)),Map.of()).andExpect(status().isOk()));assertThat(metadata.toString()).doesNotContain("synthetic-url-secret","synthetic-hmac-secret","private?","hmacSecret","ciphertext");wire("t5-notification-channels",metadata);
        }finally{outbound.setAllowedWebhookOrigins(old);}
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"expected-version","blank-name","control-name","userinfo","fragment","ftp","short-secret","oversize-secret"})
    void rejectsInvalidConfigurationBeforeAnyCiphertextIsStored(String bad)throws Exception{
        var f=fixture();var input=channel();switch(bad){case "expected-version"->input.put("expectedVersion","1");case "blank-name"->input.put("name"," ");case "control-name"->input.put("name","unsafe\nname");case "userinfo"->input.put("url","https://user:pass@hook.example.test/path");case "fragment"->input.put("url","https://hook.example.test/path#secret");case "ftp"->input.put("url","ftp://hook.example.test/path");case "short-secret"->input.put("hmacSecret","short");case "oversize-secret"->input.put("hmacSecret","密".repeat(100));}
        long before=jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_channels",Long.class);int status=member(f,post(channels(f)),input).andReturn().getResponse().getStatus();assertThat(status).as(bad).isBetween(400,499);assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM execution_notification_channels",Long.class)).isEqualTo(before);
    }
    @Test void existingWorkspaceAdminGuardAndCipherPrimitiveRemainFailClosed()throws Exception{
        var f=fixture();long user=scheduleUsers.findByUsername("admin").orElseThrow().id();jdbc.update("UPDATE memberships SET role='EDITOR' WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),user);
        try{member(f,post(channels(f)),channel()).andExpect(status().isForbidden());member(f,get(channels(f)),Map.of()).andExpect(status().isForbidden());}finally{jdbc.update("UPDATE memberships SET role='OWNER' WHERE workspace_id=? AND user_id=?",Long.valueOf(f.ws()),user);}
        var first=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated()));String id=first.path("id").asText();jdbc.update("UPDATE execution_notification_channels SET version=version+1 WHERE id=?",Long.valueOf(id));
        var meta=body(member(f,get(channels(f)),Map.of()).andExpect(status().isOk()));assertThat(meta.path("items").findValuesAsText("status")).contains("unavailable");
        String old=scheduleExecutionProperties().getMaterials().getMasterKeyFile();try{scheduleExecutionProperties().getMaterials().setMasterKeyFile("missing-synthetic-notification-key");member(f,post(channels(f)),channel()).andExpect(status().isServiceUnavailable());var input=save(f);member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated());}finally{scheduleExecutionProperties().getMaterials().setMasterKeyFile(old);}
    }
    @Autowired ExecutionProperties cryptoProperties;
    ExecutionProperties scheduleExecutionProperties(){return cryptoProperties;}
    @Test void selectableCatalogAndScheduleSelectionUseTheRealSameWorkspaceChannel()throws Exception{
        var f=fixture();var channel=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated()));String id=channel.path("id").asText();
        var options=body(member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk()));assertThat(options.path("channels").findValuesAsText("id")).contains(id);
        var input=save(f);input.put("notifications",Map.of("inApp",true,"eventKinds",List.of("failed"),"channelIds",List.of(id)));member(f,post(f.url()+"/schedules"),input).andExpect(status().isCreated());
    }
    @Test void versionedUpdateAndDeleteNeverSilentlyReuseTheOldChannelVersion()throws Exception{
        var f=fixture();String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();
        var change=new LinkedHashMap<String,Object>();change.put("expectedVersion","1");change.put("url","https://hook.example.test/new-address?key=new-synthetic-secret");
        member(f,put(channels(f)+"/"+id),change).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("2"));
        member(f,put(channels(f)+"/"+id),change).andExpect(status().isConflict());
        member(f,put(channels(f)+"/"+id),Map.of("expectedVersion","2","enabled",false)).andExpect(status().isOk()).andExpect(jsonPath("$.version").value("3")).andExpect(jsonPath("$.status").value("disabled"));
        assertThat(body(member(f,get(f.url()+"/schedules/options"),Map.of()).andExpect(status().isOk())).path("channels").findValuesAsText("id")).doesNotContain(id);
        member(f,delete(channels(f)+"/"+id+"?expectedVersion=3"),Map.of()).andExpect(status().isNoContent());assertThat(jdbc.queryForObject("SELECT deleted FROM execution_notification_channels WHERE id=?",Boolean.class,Long.valueOf(id))).isTrue();
    }
    Map<String,Object> limits(){return new LinkedHashMap<>(Map.of("requestTimeoutMs",1000,"maxAttempts",2,"retryMinMs",1000,"retryMaxMs",2000,"jitterRatio",0.0,"deliveryTtlMs",10000,"maxPayloadBytes",1024,"maxResponseBytes",128));}
    @Test void storesChannelLimitsWithinDeploymentCeilings()throws Exception{
        var f=fixture();var input=channel();input.put("limits",limits());member(f,post(channels(f)),input).andExpect(status().isCreated()).andExpect(jsonPath("$.limits.requestTimeoutMs").value(1000)).andExpect(jsonPath("$.limits.maxAttempts").value(2));
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"requestTimeoutMs","maxAttempts","deliveryTtlMs","maxPayloadBytes","maxResponseBytes","jitterRatio","retryMaxMs"})
    void neverLetsWorkspaceChannelLimitsRelaxDeploymentCeilings(String field)throws Exception{
        var f=fixture();var input=channel();var limits=limits();limits.put(field,field.equals("jitterRatio")?0.9:field.equals("requestTimeoutMs")?6000:field.equals("maxAttempts")?6:field.equals("deliveryTtlMs")?86400001:field.equals("maxPayloadBytes")?16385:field.equals("maxResponseBytes")?8193:300001);input.put("limits",limits);member(f,post(channels(f)),input).andExpect(status().isBadRequest());
    }
    @Test void disablingAndReenablingWithTheSameKeyKeepsCiphertextBoundToEveryVersion()throws Exception{
        var f=fixture();String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();member(f,put(channels(f)+"/"+id),Map.of("expectedVersion","1","enabled",false)).andExpect(status().isOk());member(f,put(channels(f)+"/"+id),Map.of("expectedVersion","2","enabled",true)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("available"));
    }
    @Test void channelChangesLeaveOnlyVersionedOperatorAuditMetadata()throws Exception{
        var f=fixture();String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();var rows=jdbc.queryForList("SELECT actor_id,action,scope_type,scope_id,version FROM execution_management_audit WHERE scope_type='notify-channel' AND scope_id=? ORDER BY id",Long.valueOf(id));assertThat(rows).hasSize(1);assertThat(rows.getFirst().get("action")).isEqualTo("notification-channel.create");member(f,put(channels(f)+"/"+id),Map.of("expectedVersion","1","enabled",false)).andExpect(status().isOk());member(f,delete(channels(f)+"/"+id+"?expectedVersion=2"),Map.of()).andExpect(status().isNoContent());rows=jdbc.queryForList("SELECT actor_id,action,scope_type,scope_id,version FROM execution_management_audit WHERE scope_type='notify-channel' AND scope_id=? ORDER BY id",Long.valueOf(id));assertThat(rows.stream().map(r->r.get("version"))).containsExactly(1L,2L,3L);assertThat(rows.stream().map(r->r.get("action"))).containsExactly("notification-channel.create","notification-channel.update","notification-channel.delete");assertThat(rows.stream().map(r->r.get("actor_id"))).containsOnly(scheduleUsers.findByUsername("admin").orElseThrow().id());assertThat(rows.toString()).doesNotContain("synthetic-url-secret","synthetic-hmac-secret","https://");
    }
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"disabled-name","url-bytes"})
    void metadataAndEncryptedMaterialBoundsApplyToAllWrites(String bad)throws Exception{
        var f=fixture();String id=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();var patch=new LinkedHashMap<String,Object>();patch.put("expectedVersion","1");if(bad.equals("disabled-name")){patch.put("enabled",false);patch.put("name","unsafe\nname");}else patch.put("url","https://hook.example.test/"+"密".repeat(3000));int status=member(f,put(channels(f)+"/"+id),patch).andReturn().getResponse().getStatus();assertThat(status).isEqualTo(400);assertThat(jdbc.queryForObject("SELECT version FROM execution_notification_channels WHERE id=?",Long.class,Long.valueOf(id))).isEqualTo(1);
    }
    @Autowired com.autumnharvestc.server.execution.notifications.ChannelCipher channelCipher;
    @Autowired com.autumnharvestc.server.store.IdGeneration ids;
    @Autowired com.autumnharvestc.server.execution.notifications.NotificationChannelRepo channelRows;
    @org.junit.jupiter.params.ParameterizedTest @org.junit.jupiter.params.provider.ValueSource(strings={"workspace","channel","version"})
    void actualStoredCiphertextRejectsEveryRelocatedDomain(String moved)throws Exception{
        var f=fixture();String first=body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText();long target=Long.valueOf(first),ws=Long.valueOf(f.ws());if(moved.equals("channel")){target=Long.valueOf(body(member(f,post(channels(f)),channel()).andExpect(status().isCreated())).path("id").asText());var material=jdbc.queryForMap("SELECT key_id,nonce,ciphertext FROM execution_notification_channels WHERE id=?",Long.valueOf(first));jdbc.update("UPDATE execution_notification_channels SET key_id=?,nonce=?,ciphertext=? WHERE id=?",material.get("key_id"),material.get("nonce"),material.get("ciphertext"),target);}else if(moved.equals("version"))jdbc.update("UPDATE execution_notification_channels SET version=2 WHERE id=?",target);else{ws=9223372036854775000L;jdbc.update("UPDATE execution_notification_channels SET workspace_id=? WHERE id=?",ws,target);}var stored=channelRows.find(ws,target,false).orElseThrow();assertThatThrownBy(()->channelCipher.open(stored)).isInstanceOf(com.autumnharvestc.server.core.ApiException.class).hasMessageNotContaining("synthetic-hmac-secret").hasMessageNotContaining("synthetic-url-secret");
    }
    @Test void realFileBackedChannelRepositoryNeverPersistsPlainEndpointOrSignatureMaterial()throws Exception{
        var folder=java.nio.file.Files.createTempDirectory("apicc-t5-cipher-");var source=new org.springframework.jdbc.datasource.DriverManagerDataSource("jdbc:h2:file:"+folder.resolve("channels").toString().replace('\\','/'),"sa","");var disk=new org.springframework.jdbc.core.JdbcTemplate(source);
        try{new org.springframework.jdbc.datasource.init.ResourceDatabasePopulator(new org.springframework.core.io.ClassPathResource("schema.sql")).execute(source);var repo=new com.autumnharvestc.server.execution.notifications.NotificationChannelRepo(disk,ids);long id=repo.reserve(7,"合成文件渠道",true,"https://hook.example.test");repo.ciphertext(id,channelCipher.seal(7,id,1,"https://hook.example.test/private?key=synthetic-disk-url-secret","synthetic-disk-hmac-secret"));try(var connection=source.getConnection();var statement=connection.createStatement()){statement.execute("SHUTDOWN");}try(var files=java.nio.file.Files.list(folder)){for(var file:files.toList()){byte[] bytes=java.nio.file.Files.readAllBytes(file);String raw=new String(bytes,java.nio.charset.StandardCharsets.ISO_8859_1);assertThat(raw).doesNotContain("synthetic-disk-url-secret","synthetic-disk-hmac-secret");}}}
        finally{try(var files=java.nio.file.Files.list(folder)){for(var file:files.toList())java.nio.file.Files.deleteIfExists(file);}java.nio.file.Files.delete(folder);}
    }
}
