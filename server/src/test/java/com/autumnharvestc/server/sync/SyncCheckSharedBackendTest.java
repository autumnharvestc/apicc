package com.autumnharvestc.server.sync;

import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.assertj.core.api.SoftAssertions;
import static org.assertj.core.api.Assertions.*;

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SyncCheckSharedBackendTest {
    SyncCheckSharedBackendFixture fixture;
    SyncCheckSharedBackendFixture.Backend first,second;
    @BeforeAll void realProcesses() throws Exception {fixture=new SyncCheckSharedBackendFixture();first=fixture.start("first");fixture.register(first);fixture.migrationPrerequisite();}
    @BeforeEach void secondBackendForIndependentChecks(TestInfo info) throws Exception {
        if(second==null&&!info.getTestMethod().orElseThrow().getName().equals("newBackendPreservesLiveOwnerAndForeignScopeDeletionCollectsItsActualRead"))second=fixture.start("second");
    }
    @AfterAll void stopOwnedProcesses() throws Exception {if(fixture!=null)fixture.close();}

    @Test @Order(1) void newBackendPreservesLiveOwnerAndForeignScopeDeletionCollectsItsActualRead() throws Exception {
        var scope=fixture.blocked(first);var owner=fixture.owner(scope);assertThat(owner).isSameAs(first);
        var before=fixture.facts("before-second-start",scope,owner);assertThat(before.path("held").asInt()).isEqualTo(1);assertThat(before.path("deadlineRemainingMs").asLong()).isGreaterThan(30000);
        var softly=new SoftAssertions();
        try{
            second=fixture.start("second");var started=fixture.facts("after-second-start",scope,owner);
            assertThat(started.path("deadlineRemainingMs").asLong()).as("The actual read remains within its finite synthetic deadline").isGreaterThan(10000);
            assertThat(started.path("held").asInt()).as("The actual source is still held, not naturally timed out").isEqualTo(1);
            softly.assertThat(fixture.check(second,scope).path("state").asText()).as("A new backend must preserve the live owner").isEqualTo("running");
            fixture.request(second,"DELETE",scope.projectUrl(),null,204);
            softly.assertThat(fixture.collected(scope)).as("A non-owner scope deletion must collect the actual source socket within the original six-second bound").isTrue();
            fixture.facts("foreign-project-deleted",scope,owner);
        }finally{fixture.release(scope);assertThat(fixture.collected(scope)).as("Owned diagnostic cleanup collects the real source").isTrue();}
        softly.assertAll();
    }

    @Test @Order(2) void foreignCancelReachesTheActualOwnerWithoutPrematureLostState() throws Exception {
        var scope=fixture.blocked(first);var owner=fixture.owner(scope);var peer=fixture.peer(owner);var before=fixture.facts("before-foreign-cancel",scope,owner);
        assertThat(before.path("state").asText()).isEqualTo("running");assertThat(before.path("held").asInt()).isEqualTo(1);assertThat(before.path("deadlineRemainingMs").asLong()).isGreaterThan(10000);
        var softly=new SoftAssertions();
        try{
            fixture.request(peer,"POST",scope.projectUrl()+"/sync/checks/"+scope.check()+"/cancel",fixture.json.createObjectNode(),202);
            assertThat(fixture.waitUntil(()->java.util.Set.of("cancelled","lost","failed","succeeded").contains(fixture.check(peer,scope).path("state").asText()),6)).as("The cancellation must settle").isTrue();
            softly.assertThat(fixture.check(peer,scope).path("state").asText()).as("A foreign owner is not a missing runtime").isEqualTo("cancelled");
            softly.assertThat(fixture.collected(scope)).as("The actual owner must close its source socket").isTrue();fixture.facts("after-foreign-cancel",scope,owner);
        }finally{fixture.release(scope);assertThat(fixture.collected(scope)).isTrue();}
        softly.assertAll();
    }

    @ParameterizedTest @ValueSource(booleans={true,false}) @Order(3)
    void staleTokenOrExpiredLeaseCannotPublishTheActualLateRead(boolean replaceToken) throws Exception {
        var scope=fixture.blocked(first);var owner=fixture.owner(scope);var before=fixture.facts("before-fence-change",scope,owner);
        assertThat(before.path("state").asText()).isEqualTo("running");assertThat(before.path("held").asInt()).isEqualTo(1);assertThat(fixture.candidates(scope)).isZero();
        try{
            fixture.invalidate(scope,replaceToken);fixture.release(scope);assertThat(fixture.collected(scope)).isTrue();
            assertThat(fixture.waitUntil(()->!owner.owns(scope.check()),6)).as("The actual old worker has settled").isTrue();
            fixture.facts(replaceToken?"late-token-return":"late-expired-return",scope,owner);
            assertThat(fixture.candidates(scope)).as("A late actual read must not publish after its durable ownership fence changes").isZero();
            if(!replaceToken)assertThat(fixture.waitUntil(()->fixture.check(fixture.peer(owner),scope).path("state").asText().equals("lost"),6)).as("The bounded expiry observer settles the invalid lease").isTrue();
        }finally{fixture.release(scope);fixture.request(fixture.peer(owner),"DELETE",scope.projectUrl(),null,204);}
    }

    @Test @Order(4) void killedOwnerIsRecoveredOnlyAfterLeaseExpiryWithoutRepeatingTheSourceRead() throws Exception {
        var scope=fixture.blocked(first);var owner=fixture.owner(scope);var peer=fixture.peer(owner);var before=fixture.facts("before-real-owner-kill",scope,owner);
        assertThat(before.path("state").asText()).isEqualTo("running");assertThat(before.path("held").asInt()).isEqualTo(1);assertThat(before.path("deadlineRemainingMs").asLong()).isGreaterThan(10000);
        int starts=before.path("calls").asInt();owner.kill();assertThat(owner.process.isAlive()).isFalse();fixture.invalidate(scope,false);
        try{
            boolean recovered=fixture.waitUntil(()->fixture.check(peer,scope).path("state").asText().equals("lost"),6);fixture.facts("after-owner-kill-and-expiry",scope,owner);
            assertThat(recovered).as("An already-running peer recovers the expired owner instead of requiring another restart").isTrue();
            assertThat(fixture.control("/control").path("calls").asInt()).as("Recovery never replays the uncertain source read").isEqualTo(starts);assertThat(fixture.candidates(scope)).isZero();
        }finally{fixture.release(scope);}
    }

    @Test @Order(3) void foreignCapabilityRevocationCollectsTheActualOwnerReadBeforeRelease() throws Exception {
        var scope=fixture.blocked(first);var owner=fixture.owner(scope);var peer=fixture.peer(owner);
        fixture.freshLeaseConfirmation(scope,owner);
        fixture.facts("before-foreign-capability-revoke",scope,owner);
        var actor=fixture.request(peer,"GET","/api/v1/me",null,200).path("id").asText();
        String member=scope.projectUrl()+"/access-members/"+actor;
        long revision=fixture.request(peer,"GET",member,null,200).path("revision").asLong();
        var update=fixture.json.createObjectNode().put("expectedRevision",revision);update.putObject("capabilities").put("sync.check","deny");
        int calls=fixture.control("/control").path("calls").asInt();
        try{
            fixture.request(peer,"PUT",member,update,200);
            boolean collected=fixture.collected(scope);fixture.facts("foreign-capability-revoked-before-release",scope,owner);
            assertThat(collected).as("A non-owner backend's committed capability revocation collects the actual source within six seconds").isTrue();
            assertThat(fixture.waitUntil(()->fixture.check(peer,scope).path("state").asText().equals("failed"),6)).isTrue();
            assertThat(fixture.check(peer,scope).path("reasonCode").asText()).isEqualTo("authorization-changed");
            assertThat(fixture.candidates(scope)).isZero();assertThat(fixture.control("/control").path("calls").asInt()).isEqualTo(calls);
        }finally{fixture.release(scope);}
    }
}
