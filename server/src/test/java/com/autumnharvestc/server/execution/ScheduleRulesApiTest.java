package com.autumnharvestc.server.execution;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.web.servlet.ResultActions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.assertj.core.api.Assertions.*;
import com.autumnharvestc.server.execution.scheduling.*;
import java.time.Instant;

class ScheduleRulesApiTest extends ExecutionManagementFixture {
    ResultActions preview(String rule,String after) throws Exception {
        var f=fixture();
        return mvc.perform(post(f.url()+"/schedules/preview").header("Authorization","Bearer "+f.token())
            .contentType("application/json").content("{\"rule\":"+rule+",\"afterUtc\":\""+after+"\"}"));
    }
    @Test void previewsShanghaiFromExplicitInstant() throws Exception {
        var f=fixture();
        mvc.perform(post(f.url()+"/schedules/preview").header("Authorization","Bearer "+f.token())
            .contentType("application/json").content("""
            {"rule":{"kind":"cron","expression":"0 0 9 * * *","timeZone":"Asia/Shanghai","dstOverlap":"first"},"afterUtc":"2026-10-29T00:00:00Z"}
            """))
            .andExpect(status().isOk()).andExpect(jsonPath("$.candidates[0].plannedAtUtc").value("2026-10-29T01:00:00Z"))
            .andExpect(jsonPath("$.candidates[0].offset").value("+08:00"));
    }
    @Test void onceReturnsOnlyTheRemainingInstant() throws Exception {
        preview("{\"kind\":\"once\",\"atUtc\":\"2026-10-29T01:00:00Z\",\"timeZone\":\"Asia/Shanghai\"}","2026-10-29T00:00:00Z")
            .andExpect(status().isOk()).andExpect(jsonPath("$.candidates.length()").value(1))
            .andExpect(jsonPath("$.candidates[0].plannedAtUtc").value("2026-10-29T01:00:00Z"));
        preview("{\"kind\":\"once\",\"atUtc\":\"2026-10-29T01:00:00Z\",\"timeZone\":\"Asia/Shanghai\"}","2026-10-29T01:00:00Z")
            .andExpect(status().isOk()).andExpect(jsonPath("$.candidates.length()").value(0));
    }
    @Test void overlapFirstSkipsTheSecondInstantAndBothKeepsIt() throws Exception {
        preview("{\"kind\":\"cron\",\"expression\":\"0 30 1 * * *\",\"timeZone\":\"America/New_York\",\"dstOverlap\":\"first\"}","2026-11-01T00:00:00Z")
            .andExpect(status().isOk()).andExpect(jsonPath("$.candidates[0].plannedAtUtc").value("2026-11-01T05:30:00Z"))
            .andExpect(jsonPath("$.candidates[1].plannedAtUtc").value("2026-11-02T06:30:00Z"));
        preview("{\"kind\":\"cron\",\"expression\":\"0 30 1 * * *\",\"timeZone\":\"America/New_York\",\"dstOverlap\":\"both\"}","2026-11-01T00:00:00Z")
            .andExpect(status().isOk()).andExpect(jsonPath("$.candidates[1].plannedAtUtc").value("2026-11-01T06:30:00Z"))
            .andExpect(jsonPath("$.candidates[1].offset").value("-05:00"));
    }
    @Test void gapIsSkippedWithAnExplicitNotice() throws Exception {
        preview("{\"kind\":\"cron\",\"expression\":\"0 30 2 * * *\",\"timeZone\":\"America/New_York\",\"dstOverlap\":\"first\"}","2027-03-14T00:00:00Z")
            .andExpect(status().isOk()).andExpect(jsonPath("$.candidates[0].plannedAtUtc").value("2027-03-15T06:30:00Z"))
            .andExpect(jsonPath("$.notices[0]").value("dst-gap-skipped"));
    }
    @Test void bothOrdersDenseOverlapByUtcAndMissingOverlapIsRejected() throws Exception {
        preview("{\"kind\":\"cron\",\"expression\":\"0 * * * * *\",\"timeZone\":\"America/New_York\",\"dstOverlap\":\"both\"}","2026-11-01T05:58:00Z")
            .andExpect(status().isOk()).andExpect(jsonPath("$.candidates[0].plannedAtUtc").value("2026-11-01T05:59:00Z"))
            .andExpect(jsonPath("$.candidates[1].plannedAtUtc").value("2026-11-01T06:00:00Z"));
    }
    @Test void pureInputClockCanMoveBackwardWithoutCachedCandidates() {
        var calculator=new ScheduleRuleCalculator();var rule=new ScheduleDtos.CronRule("0 0 9 * * *","Asia/Shanghai","first");
        var later=calculator.preview(rule,Instant.parse("2026-10-30T00:00:00Z"),60000,10);
        var earlier=calculator.preview(rule,Instant.parse("2026-10-29T00:00:00Z"),60000,10);
        assertThat(later.candidates().getFirst().plannedAtUtc()).isEqualTo("2026-10-30T01:00:00Z");
        assertThat(earlier.candidates()).extracting(ScheduleDtos.Candidate::plannedAtUtc).containsExactly("2026-10-29T01:00:00Z","2026-10-30T01:00:00Z","2026-10-31T01:00:00Z","2026-11-01T01:00:00Z","2026-11-02T01:00:00Z");
    }
    @Test void overlapBudgetCannotReturnAnUnclosedUtcPrefix() {
        var calculator=new ScheduleRuleCalculator();
        var rule=new ScheduleDtos.CronRule("0 * * * * *","America/New_York","both");
        var after=Instant.parse("2026-11-01T05:06:00Z");
        assertThatThrownBy(()->calculator.preview(rule,after,60000,10))
            .isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("schedule-evaluation-limit"));
        var complete=calculator.preview(rule,after,60000,5000);
        assertThat(complete.candidates()).extracting(ScheduleDtos.Candidate::plannedAtUtc).containsExactly(
            "2026-11-01T05:07:00Z","2026-11-01T05:08:00Z","2026-11-01T05:09:00Z","2026-11-01T05:10:00Z","2026-11-01T05:11:00Z");
    }
    @Test void overlapBudgetCannotClaimFrequencyValidationAcrossUnvisitedInstants() {
        var calculator=new ScheduleRuleCalculator();
        var rule=new ScheduleDtos.CronRule("0 0,5,10,15,20,25,30,35,40,45,46,47,48,49,50 1 * * *","America/New_York","both");
        var after=Instant.parse("2026-11-01T05:00:00Z");
        // First ten local candidates contain five-minute gaps; the unvisited 01:46 violates that interval.
        assertThatThrownBy(()->calculator.preview(rule,after,300000,10))
            .isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("schedule-evaluation-limit"));
        assertThatThrownBy(()->calculator.preview(rule,after,300000,100))
            .isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("schedule-interval-too-short"));
    }
    @Test void budgetExhaustionAndFrequencyAfterTheFiveVisibleSamplesFailSafely() {
        var calculator=new ScheduleRuleCalculator();
        assertThatThrownBy(()->calculator.preview(new ScheduleDtos.CronRule("0 30 2 14 3 *","America/New_York","first"),Instant.parse("2027-03-14T00:00:00Z"),60000,1))
            .isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("schedule-evaluation-limit"));
        assertThatThrownBy(()->calculator.preview(new ScheduleDtos.CronRule("0 0 9 * * *","America/New_York","first"),Instant.parse("2026-10-29T00:00:00Z"),86400000,5000))
            .isInstanceOfSatisfying(com.autumnharvestc.server.core.ApiException.class,e->assertThat(e.getCode()).isEqualTo("schedule-interval-too-short"));
    }
    @ParameterizedTest @ValueSource(strings={
        "{\"kind\":\"cron\",\"expression\":\"* * * * * *\",\"timeZone\":\"Asia/Shanghai\",\"dstOverlap\":\"first\"}",
        "{\"kind\":\"cron\",\"expression\":\"0 0 9 * * *\",\"timeZone\":\"+08:00\",\"dstOverlap\":\"first\"}",
        "{\"kind\":\"cron\",\"expression\":\"0 0 9 * * *\",\"timeZone\":\"Asia/Shanghai\",\"dstOverlap\":\"third\"}",
        "{\"kind\":\"cron\",\"expression\":\"0 0 9 * * *\",\"timeZone\":\"Asia/Shanghai\",\"dstOverlap\":\"first\",\"atUtc\":\"2026-10-29T00:00:00Z\"}",
        "{\"kind\":\"cron\",\"expression\":\"0 0 9 * * *\",\"timeZone\":\"Asia/Shanghai\"}"
    }) void rejectsUnsafeRuleBranches(String rule) throws Exception { preview(rule,"2026-10-29T00:00:00Z").andExpect(status().isBadRequest()); }
}
