package com.autumnharvestc.server.sync;

import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@org.springframework.context.annotation.Import(SyncCheckOwnershipBoundaryTest.OwnedDatabase.class)
class SyncCheckOwnershipBoundaryTest extends SyncCheckHttpFixture {
    @org.springframework.boot.test.context.TestConfiguration(proxyBeanMethods=false) static class OwnedDatabase {
        @org.springframework.context.annotation.Bean static org.springframework.beans.factory.config.BeanFactoryPostProcessor ownershipDatabase(org.springframework.core.env.ConfigurableEnvironment environment){
            String url="jdbc:h2:mem:apicc-sync-ownership-"+UUID.randomUUID()+";DB_CLOSE_DELAY=-1";
            return beans->environment.getPropertySources().addFirst(new org.springframework.core.env.MapPropertySource("ownership-boundary-database",Map.of("spring.datasource.url",url)));
        }
    }
    @org.springframework.beans.factory.annotation.Autowired SyncCheckWorker worker;
    @org.springframework.beans.factory.annotation.Autowired SyncStorage accounting;
    @org.springframework.beans.factory.annotation.Autowired com.autumnharvestc.server.collaboration.artifacts.CollaborationStorage storage;
    @org.springframework.beans.factory.annotation.Autowired org.springframework.transaction.support.TransactionTemplate transactions;
    @org.springframework.beans.factory.annotation.Autowired SyncCheckService checks;
    @org.springframework.beans.factory.annotation.Autowired SyncCheckProperties ownership;

    @ParameterizedTest @CsvSource({"50,1000,1","5000,300000,1000"})
    void defaultsAndLegalOwnershipBudgetsAllowStartup(long interval,long lease,int batch){
        assertThat(ownership.getMonitorIntervalMs()).isEqualTo(250);assertThat(ownership.getLeaseMs()).isEqualTo(10000);assertThat(ownership.getRecoveryBatchSize()).isEqualTo(25);
        try(var valid=new SpringApplicationBuilder(com.autumnharvestc.server.ApiccServerApplication.class).web(WebApplicationType.NONE).run("--spring.datasource.url=jdbc:h2:mem:sync-valid-"+UUID.randomUUID(),"--apicc.scheduler.mode=disabled","--apicc.server.admin-password=synthetic-administrator-password123","--apicc.sync.check-worker.monitor-interval-ms="+interval,"--apicc.sync.check-worker.lease-ms="+lease,"--apicc.sync.check-worker.recovery-batch-size="+batch)){
            var actual=valid.getBean(SyncCheckProperties.class);assertThat(actual.getMonitorIntervalMs()).isEqualTo(interval);assertThat(actual.getLeaseMs()).isEqualTo(lease);assertThat(actual.getRecoveryBatchSize()).isEqualTo(batch);
        }
    }

    @Test @org.springframework.test.annotation.DirtiesContext(methodMode=org.springframework.test.annotation.DirtiesContext.MethodMode.AFTER_METHOD)
    void legacyUnownedRunningCheckRetainsItsFutureReadHorizonDuringRecovery() throws Exception {
        var source=createUrlSource("/fast");long w=Long.parseLong(f.workspace()),p=Long.parseLong(f.project());var id=new java.util.concurrent.atomic.AtomicReference<String>();int starts=sourceHostCalls();
        transactions.executeWithoutResult(status->{
            accounting.lock(w,p);
            try{id.set(submit(source,checkBody()).path("checkId").asText());}catch(Exception failure){throw new RuntimeException(failure);}
            // The policy gate prevents dispatch until this historical unowned running row is committed.
            jdbc.update("UPDATE sync_checks SET state='running' WHERE workspace_id=? AND project_id=? AND id=?",w,p,id.get());
        });
        checks.recover();
        assertThat(sourceHostCalls()).as("Recovery does not invent another external read").isEqualTo(starts);
        assertThat(body(sourceRequest("GET","/checks/"+id.get(),editor(),null).andExpect(status().isOk())).path("state").asText())
            .as("An unowned legacy row may still belong to an older live backend until its existing finite deadline").isEqualTo("running");
    }

    @ParameterizedTest @CsvSource({"0,10000,25","49,10000,25","5001,300000,25","250,999,25","250,300001,25","5000,1000,25","250,10000,0","250,10000,1001"})
    void invalidOwnershipMonitorBudgetsRefuseStartup(long interval,long lease,int batch){
        assertThatThrownBy(()->{
            try(var invalid=new SpringApplicationBuilder(com.autumnharvestc.server.ApiccServerApplication.class).web(WebApplicationType.NONE).run("--spring.datasource.url=jdbc:h2:mem:sync-invalid-"+UUID.randomUUID(),"--apicc.scheduler.mode=disabled","--apicc.server.admin-password=synthetic-administrator-password123","--apicc.sync.check-worker.monitor-interval-ms="+interval,"--apicc.sync.check-worker.lease-ms="+lease,"--apicc.sync.check-worker.recovery-batch-size="+batch)){
                assertThat(invalid.isActive()).isTrue();
            }
        }).as("Invalid interval/lease/batch must be rejected by actual production configuration binding").isInstanceOf(org.springframework.beans.BeansException.class).hasRootCauseInstanceOf(org.springframework.boot.context.properties.bind.validation.BindValidationException.class);
    }

    @Test void unknownOwnershipMonitorPropertiesRefuseStartup(){
        assertThatThrownBy(()->{
            try(var invalid=new SpringApplicationBuilder(com.autumnharvestc.server.ApiccServerApplication.class).web(WebApplicationType.NONE).run("--spring.datasource.url=jdbc:h2:mem:sync-unknown-"+UUID.randomUUID(),"--apicc.scheduler.mode=disabled","--apicc.server.admin-password=synthetic-administrator-password123","--apicc.sync.check-worker.monitor-interval-mss=100")){
                assertThat(invalid.isActive()).isTrue();
            }
        }).isInstanceOf(org.springframework.beans.BeansException.class).hasRootCauseInstanceOf(org.springframework.boot.context.properties.bind.UnboundConfigurationPropertiesException.class);
    }

    @Test @org.springframework.test.annotation.DirtiesContext(methodMode=org.springframework.test.annotation.DirtiesContext.MethodMode.AFTER_METHOD)
    void ownershipColumnsConsumeTheExistingFiniteProgressFrameInsteadOfGrowingOccupiedBytes() throws Exception {
        worker.close();var threads=(List<Thread>)org.springframework.test.util.ReflectionTestUtils.getField(worker,"dispatchers");for(var thread:threads)thread.join(2000);
        String id=null;
        try{
            // Test-only migration prerequisite, never the product schema change before RED.
            jdbc.execute("ALTER TABLE sync_checks ADD COLUMN IF NOT EXISTS owner_id VARCHAR(36)");jdbc.execute("ALTER TABLE sync_checks ADD COLUMN IF NOT EXISTS ownership_token VARCHAR(36)");jdbc.execute("ALTER TABLE sync_checks ADD COLUMN IF NOT EXISTS lease_until_utc TIMESTAMP(9) WITH TIME ZONE");
            var source=createUrlSource("/fast");id=submit(source,checkBody()).path("checkId").asText();long w=Long.parseLong(f.workspace()),p=Long.parseLong(f.project());var before=storage.usage(w,p);String check=id;
            transactions.executeWithoutResult(status->{accounting.lock(w,p);accounting.changed(w,p);assertThat(jdbc.update("UPDATE sync_checks SET owner_id=?,ownership_token=?,lease_until_utc=TIMESTAMP WITH TIME ZONE '2026-11-06 12:00:00.123456789+00' WHERE workspace_id=? AND project_id=? AND id=?","11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222",w,p,check)).isEqualTo(1);});
            var after=storage.usage(w,p);assertThat(after.actualBytes()).isGreaterThan(before.actualBytes());
            assertThat(after.occupiedBytes()).as("Bounded runtime ownership metadata consumes the already reserved 512-byte progress frame").isEqualTo(before.occupiedBytes());
            assertThat(after.reservedAuditBytes()).isLessThan(before.reservedAuditBytes());
        }finally{
            if(id!=null)sourceRequest("POST","/checks/"+id+"/cancel",editor(),json.createObjectNode()).andExpect(status().isAccepted());
            // This method's private test context is destroyed; a closed production singleton is never revived.
        }
    }
}
