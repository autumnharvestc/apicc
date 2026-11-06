package com.autumnharvestc.server.sync;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.sql.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.h2.tools.Server;
import static org.assertj.core.api.Assertions.*;

/** Two real Java backends, one owned H2 TCP authority and one actual Node source host. */
final class SyncCheckSharedBackendFixture implements AutoCloseable {
    final ObjectMapper json=new ObjectMapper();
    final SyncCheckHttpFixture.Node node=new SyncCheckHttpFixture.Node();
    final Path directory=Files.createTempDirectory("apicc-sync-owners-"),key=directory.resolve("master-key.bin");
    final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    final Server databaseServer;
    final String database;
    final long monitorIntervalMs,leaseMs;
    final List<Backend> backends=new ArrayList<>();
    String token;
    record Scope(String workspace,String project,String source,String barrier,String check){String workspaceUrl(){return "/api/v1/workspaces/"+workspace;}String projectUrl(){return workspaceUrl()+"/projects/"+project;}}
    final class Backend {
        final String role,base;final Path files;final Process process;
        Backend(String role) throws Exception {
            this.role=role;files=Files.createDirectory(directory.resolve(role));int port;try(var socket=new ServerSocket(0)){port=socket.getLocalPort();}base="http://127.0.0.1:"+port;
            Path executable=SyncScheduleProcessProbe.javaExecutable(Path.of(System.getProperty("java.home")),System.getProperty("os.name"));
            var args=new ArrayList<>(List.of(executable.toString(),"-cp",System.getProperty("surefire.test.class.path",System.getProperty("java.class.path")),SyncCheckProcessBackend.class.getName(),files.toString(),"--server.address=127.0.0.1","--server.port="+port,"--spring.datasource.url="+database,"--apicc.server.allow-registration=true","--apicc.server.admin-password=synthetic-administrator-password123","--apicc.scheduler.mode=disabled","--apicc.sync.check-worker.monitor-interval-ms="+monitorIntervalMs,"--apicc.sync.check-worker.lease-ms="+leaseMs,"--apicc.collaboration.runtime.enabled=true","--apicc.collaboration.runtime.base-url="+node.info.path("url").asText(),"--apicc.collaboration.runtime.secret-file="+node.info.path("secretFile").asText(),"--apicc.execution.materials.master-key-file="+key));
            Files.writeString(files.resolve("command.json"),json.writeValueAsString(args));
            process=new ProcessBuilder(args).redirectErrorStream(true).redirectOutput(files.resolve("backend.log").toFile()).start();backends.add(this);
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
            while(System.nanoTime()<until){if(!process.isAlive())throw new AssertionError("Owned "+role+" prerequisite exited: "+Files.readString(files.resolve("backend.log")));if(Files.exists(files.resolve("ready.json")))return;Thread.sleep(25);}
            throw new AssertionError("Owned backend prerequisite readiness deadline: "+role);
        }
        boolean owns(String check) throws Exception {
            var facts=observation();for(var value:facts.path("checks"))if(value.asText().equals(check))return true;return false;
        }
        JsonNode observation() throws Exception {
            String nonce=UUID.randomUUID().toString();Files.writeString(files.resolve("work-query.txt"),nonce);Path answer=files.resolve("answer-"+nonce+".json");
            assertThat(awaitFile(answer,3)).as("Owned backend observation prerequisite").isTrue();var facts=json.readTree(Files.readString(answer));
            return facts;
        }
        void kill() throws Exception {process.destroyForcibly();assertThat(process.waitFor(5,TimeUnit.SECONDS)).isTrue();}
        void stop() throws Exception {if(!process.isAlive())return;process.destroy();if(!process.waitFor(8,TimeUnit.SECONDS))kill();}
    }
    SyncCheckSharedBackendFixture() throws Exception {this(250,10000);}
    SyncCheckSharedBackendFixture(long monitorIntervalMs,long leaseMs) throws Exception {
        this.monitorIntervalMs=monitorIntervalMs;this.leaseMs=leaseMs;
        Files.write(key,new byte[32]);databaseServer=Server.createTcpServer("-tcpPort","0","-tcpDaemon","-ifNotExists","-baseDir",directory.toString()).start();
        database="jdbc:h2:tcp://127.0.0.1:"+databaseServer.getPort()+"/./metadata;DB_CLOSE_ON_EXIT=FALSE;WRITE_DELAY=0";
        Files.writeString(directory.resolve("environment.json"),json.writeValueAsString(Map.of("javaVersion",System.getProperty("java.version"),"javaHome",System.getProperty("java.home"),"node",System.getenv().getOrDefault("APICC_TEST_NODE","node"),"nodeDirectory",node.directory.toString(),"nodePid",node.process.pid(),"database",database)));
        System.out.println("SYNC_OWNERS_ARTIFACTS "+directory);
    }
    Backend start(String role) throws Exception {return new Backend(role);}
    JsonNode request(Backend backend,String method,String path,JsonNode body,int status) throws Exception {
        var builder=HttpRequest.newBuilder(URI.create(backend.base+path)).timeout(Duration.ofSeconds(15));if(token!=null)builder.header("Authorization","Bearer "+token);if(body!=null)builder.header("Content-Type","application/json");
        var response=http.send(builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(body.toString())).build(),HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).withFailMessage(method+" "+path+" status="+response.statusCode()+" body="+response.body()).isEqualTo(status);return response.body().isBlank()?json.nullNode():json.readTree(response.body());
    }
    void register(Backend backend) throws Exception {
        String name="owners-"+UUID.randomUUID().toString().substring(0,16);var registration=json.createObjectNode().put("username",name).put("password","synthetic-password123").put("displayName",name);
        request(backend,"POST","/api/v1/auth/register",registration,201);token=request(backend,"POST","/api/v1/auth/login",registration,200).path("token").asText();
    }
    Scope blocked(Backend backend) throws Exception {
        String workspace=request(backend,"POST","/api/v1/workspaces",json.createObjectNode().put("name","Owned runtime "+UUID.randomUUID().toString().substring(0,8)),201).path("id").asText(),workspaceUrl="/api/v1/workspaces/"+workspace;
        // Synthetic test-only finite read horizon, leaving room for starting the second actual JVM.
        var policy=json.createObjectNode().put("formatVersion",1).put("intentId",UUID.randomUUID().toString()).put("expectedRevision","0");policy.set("policy",json.createObjectNode().put("formatVersion",1).put("scope","workspace").put("revision","1").put("urlDeadlineMs",180000));request(backend,"PUT",workspaceUrl+"/sync/policy",policy,200);
        String group=request(backend,"POST",workspaceUrl+"/groups",json.createObjectNode().put("name","Owned"),201).path("id").asText();
        String project=request(backend,"POST",workspaceUrl+"/projects",json.createObjectNode().put("name","Owned").put("groupId",group),201).path("id").asText(),projectUrl=workspaceUrl+"/projects/"+project;
        var assets=json.createObjectNode().put("format","contract-files-v1").put("contractProjectId","00000000-0000-4000-8000-000000000070").put("expectedVersion","0");assets.set("changes",node.info.path("files"));assets.putArray("deletes");request(backend,"PUT",projectUrl+"/assets",assets,200);
        String source=UUID.randomUUID().toString(),barrier=UUID.randomUUID().toString();var definition=json.createObjectNode().put("formatVersion",1).put("id",source).put("revision","1").put("moduleId","00000000-0000-4000-8000-000000000071").put("kind","url").put("url",node.info.path("origin").asText()+"/blocked/"+barrier);
        var save=json.createObjectNode().put("formatVersion",1).put("intentId",UUID.randomUUID().toString()).put("expectedAssetVersion","1").put("expectedSourceRevision","0");save.set("source",definition);request(backend,"POST",projectUrl+"/sync/sources",save,201);
        var check=json.createObjectNode().put("formatVersion",1).put("intentId",UUID.randomUUID().toString()).put("expectedSourceRevision","1").put("expectedAssetVersion","1");String id=request(backend,"POST",projectUrl+"/sync/sources/"+source+"/checks",check,202).path("checkId").asText();
        assertThat(awaitFile(node.directory.resolve("received-"+barrier),6)).as("Actual source read prerequisite").isTrue();return new Scope(workspace,project,source,barrier,id);
    }
    Backend owner(Scope scope) throws Exception {
        var owners=new ArrayList<Backend>();for(var backend:backends)if(backend.process.isAlive()&&backend.owns(scope.check()))owners.add(backend);
        assertThat(owners).as("Exactly one actual process owns "+scope.check()).hasSize(1);return owners.getFirst();
    }
    Backend peer(Backend owner){return backends.stream().filter(backend->backend!=owner&&backend.process.isAlive()).findFirst().orElseThrow();}
    JsonNode check(Backend backend,Scope scope) throws Exception {return request(backend,"GET",scope.projectUrl()+"/sync/checks/"+scope.check(),null,200);}
    Connection connection() throws Exception {return DriverManager.getConnection(database,"sa","");}
    void migrationPrerequisite() throws Exception {
        try(var connection=connection();var statement=connection.createStatement()){
            // Test-only nullable-column preparation: product schema remains unchanged until verified RED.
            statement.execute("ALTER TABLE sync_checks ADD COLUMN IF NOT EXISTS owner_id VARCHAR(36)");statement.execute("ALTER TABLE sync_checks ADD COLUMN IF NOT EXISTS ownership_token VARCHAR(36)");statement.execute("ALTER TABLE sync_checks ADD COLUMN IF NOT EXISTS lease_until_utc TIMESTAMP(9) WITH TIME ZONE");
        }
    }
    long candidates(Scope scope) throws Exception {try(var connection=connection();var statement=connection.prepareStatement("SELECT COUNT(*) FROM sync_candidates WHERE workspace_id=? AND project_id=? AND source_id=?")){statement.setLong(1,Long.parseLong(scope.workspace()));statement.setLong(2,Long.parseLong(scope.project()));statement.setString(3,scope.source());try(var rows=statement.executeQuery()){rows.next();return rows.getLong(1);}}}
    void invalidate(Scope scope,boolean token) throws Exception {
        try(var connection=connection();var statement=connection.prepareStatement(token?"UPDATE sync_checks SET owner_id=?,ownership_token=?,lease_until_utc=DATEADD('SECOND',30,CURRENT_TIMESTAMP) WHERE workspace_id=? AND project_id=? AND id=?":"UPDATE sync_checks SET owner_id=COALESCE(owner_id,?),ownership_token=COALESCE(ownership_token,?),lease_until_utc=DATEADD('SECOND',-1,CURRENT_TIMESTAMP) WHERE workspace_id=? AND project_id=? AND id=?")){
            statement.setString(1,UUID.randomUUID().toString());statement.setString(2,UUID.randomUUID().toString());statement.setLong(3,Long.parseLong(scope.workspace()));statement.setLong(4,Long.parseLong(scope.project()));statement.setString(5,scope.check());assertThat(statement.executeUpdate()).isEqualTo(1);
        }
    }
    void ownershipPrerequisite(Scope scope,long lease) throws Exception {
        try(var connection=connection();var statement=connection.prepareStatement("UPDATE sync_checks SET owner_id=COALESCE(owner_id,?),ownership_token=COALESCE(ownership_token,?),lease_until_utc=COALESCE(lease_until_utc,DATEADD('MILLISECOND',?,CURRENT_TIMESTAMP)) WHERE workspace_id=? AND project_id=? AND id=?")){
            statement.setString(1,UUID.randomUUID().toString());statement.setString(2,UUID.randomUUID().toString());statement.setLong(3,lease);statement.setLong(4,Long.parseLong(scope.workspace()));statement.setLong(5,Long.parseLong(scope.project()));statement.setString(6,scope.check());assertThat(statement.executeUpdate()).isEqualTo(1);
        }
    }
    boolean renewalBlockedBy(int blocker) throws Exception {
        try(var connection=connection();var statement=connection.prepareStatement("SELECT COUNT(*) FROM INFORMATION_SCHEMA.SESSIONS WHERE BLOCKER_ID=? AND LOWER(EXECUTING_STATEMENT) LIKE '%sync_checks%' AND LOWER(EXECUTING_STATEMENT) LIKE '%lease_until_utc%' AND (LOWER(EXECUTING_STATEMENT) LIKE 'update%' OR LOWER(EXECUTING_STATEMENT) LIKE '%for update%')")){
            statement.setInt(1,blocker);try(var rows=statement.executeQuery()){rows.next();return rows.getInt(1)>0;}
        }
    }
    void freshLeaseConfirmation(Scope scope,Backend owner) throws Exception {
        var initial=leaseFacts(scope);long firstUntil=initial.path("leaseUntilMs").asLong();
        assertThat(waitUntil(()->{
            var persisted=leaseFacts(scope);var observed=owner.observation();
            if(persisted.path("leaseUntilMs").asLong()<=firstUntil||persisted.path("dbLeaseRemainingMs").asLong()<leaseMs/2||observed.path("localLeaseRemainingMs").path(scope.check()).asLong()<leaseMs/2)return false;
            var confirmed=(ObjectNode)persisted.deepCopy();confirmed.set("actualOwnerObservation",observed);Files.writeString(directory.resolve("fresh-lease-confirmation.json"),confirmed.toPrettyString());return true;
        },3)).as("A real renewal commit and fresh owner ACK must precede the short-lease blocking experiment").isTrue();
    }
    JsonNode leaseFacts(Scope scope) throws Exception {
        try(var connection=connection();var statement=connection.prepareStatement("SELECT lease_until_utc,DATEADD('MILLISECOND',APICC_SCHEDULER_EPOCH_MILLIS(),TIMESTAMP WITH TIME ZONE '1970-01-01 00:00:00+00') FROM sync_checks WHERE workspace_id=? AND project_id=? AND id=?")){
            statement.setLong(1,Long.parseLong(scope.workspace()));statement.setLong(2,Long.parseLong(scope.project()));statement.setString(3,scope.check());try(var rows=statement.executeQuery()){assertThat(rows.next()).isTrue();var until=rows.getObject(1,OffsetDateTime.class);var now=rows.getObject(2,OffsetDateTime.class);return json.createObjectNode().put("leaseUntilMs",until==null?0:until.toInstant().toEpochMilli()).put("dbLeaseRemainingMs",until==null?0:Duration.between(now,until).toMillis());}
        }
    }
    JsonNode facts(String phase,Scope scope,Backend owner) throws Exception {
        var control=control("/control");var facts=(ObjectNode)control.deepCopy();facts.put("phase",phase).put("check",scope.check()).put("ownerRole",owner.role).put("ownerPid",owner.process.pid()).put("ownerAlive",owner.process.isAlive()).put("collected",Files.exists(node.directory.resolve("collected-"+scope.barrier())));
        try(var connection=connection();var statement=connection.prepareStatement("SELECT details_json,state FROM sync_checks WHERE workspace_id=? AND project_id=? AND id=?")){statement.setLong(1,Long.parseLong(scope.workspace()));statement.setLong(2,Long.parseLong(scope.project()));statement.setString(3,scope.check());try(var rows=statement.executeQuery()){if(rows.next()){facts.put("state",rows.getString(2));facts.put("deadlineRemainingMs",json.readTree(rows.getString(1)).path("deadlineAtMs").asLong()-System.currentTimeMillis());}}}
        Files.writeString(directory.resolve("events.jsonl"),facts+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);System.out.println("SYNC_OWNERS_FACTS "+facts);return facts;
    }
    JsonNode control(String path) throws Exception {var response=http.send(HttpRequest.newBuilder(URI.create(node.info.path("origin").asText()+path)).timeout(Duration.ofSeconds(3)).GET().build(),HttpResponse.BodyHandlers.ofString());return path.equals("/control")?json.readTree(response.body()):json.nullNode();}
    boolean collected(Scope scope) throws Exception {return awaitFile(node.directory.resolve("collected-"+scope.barrier()),6);}
    void release(Scope scope) throws Exception {control("/release/"+scope.barrier());}
    boolean waitUntil(java.util.concurrent.Callable<Boolean> condition,int seconds) throws Exception {long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds);do{if(condition.call())return true;Thread.sleep(10);}while(System.nanoTime()<until);return condition.call();}
    static boolean awaitFile(Path file,int seconds) throws Exception {long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(seconds);while(System.nanoTime()<until){if(Files.exists(file))return true;Thread.sleep(10);}return Files.exists(file);}
    @Override public void close() throws Exception {for(var backend:backends)backend.stop();node.close();databaseServer.stop();}
}
