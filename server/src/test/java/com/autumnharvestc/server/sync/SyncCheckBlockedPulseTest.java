package com.autumnharvestc.server.sync;

import org.junit.jupiter.api.Test;
import org.assertj.core.api.SoftAssertions;
import static org.assertj.core.api.Assertions.*;

class SyncCheckBlockedPulseTest {
    @Test void blockedDatabaseRenewalCannotBlockTheIndependentLocalLeaseDeadline() throws Exception {
        try(var fixture=new SyncCheckSharedBackendFixture(100,1000)){
            var first=fixture.start("first");fixture.register(first);fixture.migrationPrerequisite();fixture.start("second");
            var scope=fixture.blocked(first);var owner=fixture.owner(scope);var before=fixture.facts("before-blocking-renewal",scope,owner);
            assertThat(before.path("held").asInt()).isEqualTo(1);assertThat(before.path("state").asText()).isEqualTo("running");assertThat(before.path("deadlineRemainingMs").asLong()).isGreaterThan(10000);
            // Only fill the proposed nullable columns when running against the untouched legacy product.
            fixture.ownershipPrerequisite(scope,1000);
            fixture.freshLeaseConfirmation(scope,owner);
            var softly=new SoftAssertions();
            try(var lock=fixture.connection()){
                lock.setAutoCommit(false);int session;try(var statement=lock.createStatement();var rows=statement.executeQuery("SELECT SESSION_ID()")){rows.next();session=rows.getInt(1);}
                try(var statement=lock.prepareStatement("SELECT id FROM sync_checks WHERE workspace_id=? AND project_id=? AND id=? FOR UPDATE")){
                    statement.setLong(1,Long.parseLong(scope.workspace()));statement.setLong(2,Long.parseLong(scope.project()));statement.setString(3,scope.check());try(var rows=statement.executeQuery()){assertThat(rows.next()).isTrue();}
                }
                try{
                    boolean blocked=fixture.waitUntil(()->fixture.renewalBlockedBy(session),1);
                    softly.assertThat(blocked).as("The real product renewal pulse is blocked by the still-held ownership row lock").isTrue();
                    boolean collected=fixture.collected(scope);var during=fixture.facts("ownership-lock-still-held",scope,owner);
                    ((com.fasterxml.jackson.databind.node.ObjectNode)during).put("productRenewalBlocked",blocked).put("lockSession",session).put("lockStillHeld",true);
                    java.nio.file.Files.writeString(fixture.directory.resolve("blocked-pulse-facts.json"),during.toPrettyString());
                    softly.assertThat(collected).as("The independent tick must close the actual socket within six seconds while the DB row remains locked").isTrue();
                    assertThat(during.path("deadlineRemainingMs").asLong()).as("The source business deadline cannot explain collection").isGreaterThan(10000);
                }finally{lock.rollback();}
            }finally{fixture.release(scope);assertThat(fixture.collected(scope)).isTrue();}
            softly.assertAll();
        }
    }
}
