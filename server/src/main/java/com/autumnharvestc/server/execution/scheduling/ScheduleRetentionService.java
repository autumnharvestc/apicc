package com.autumnharvestc.server.execution.scheduling;

import java.util.*;
import java.time.*;
import org.springframework.stereotype.Service;

@Service
public class ScheduleRetentionService {
    private final ScheduleOccurrenceRepo repo;private final ScheduleControlService control;private final ScheduleTimeSource time;private final SchedulePolicyService policies;private final SchedulerProperties properties;private final org.springframework.transaction.support.TransactionTemplate transaction;
    public ScheduleRetentionService(ScheduleOccurrenceRepo repo,ScheduleControlService control,ScheduleTimeSource time,SchedulePolicyService policies,SchedulerProperties properties,org.springframework.transaction.support.TransactionTemplate transaction){this.repo=repo;this.control=control;this.time=time;this.policies=policies;this.properties=properties;this.transaction=transaction;}
    public record Proof(boolean noActiveJob,boolean noPendingNotification){}
    /** T4/T5 supply both proofs via synchronous database reads under this transaction. No adapter is registered in T3. */
    @FunctionalInterface public interface References { Proof inspect(ScheduleOccurrenceRepo.Row occurrence); }
    public int prune(List<String> occurrenceIds,References references){
        if(references==null)return 0;
        int removed=0;
        for(String id:occurrenceIds.stream().limit(properties.getBatchSize()).toList())removed+=transaction.execute(status->{
            control.lock();var candidate=repo.find(com.autumnharvestc.server.execution.agent.AgentRepo.id(id),false);if(candidate.isEmpty())return 0;
            var original=candidate.orElseThrow();repo.lockProject(original.scope());repo.lockSchedule(original.scope());var current=repo.find(original.id(),true);if(current.isEmpty())return 0;var row=current.orElseThrow();var now=time.now();
            if(!Set.of("skipped","rejected","expired","submitted").contains(row.state())||row.terminalAt()==null||row.leaseUntil()!=null&&now.isBefore(row.leaseUntil()))return 0;
            long days=((Number)((Map<?,?>)policies.effective(row.scope().workspace(),row.scope().project()).get("effective")).get("historyRetentionDays")).longValue();var cutoff=now.minus(Duration.ofDays(days));if(row.terminalAt().isAfter(cutoff))return 0;
            var proof=references.inspect(row);if(proof==null||!proof.noActiveJob()||!proof.noPendingNotification())return 0;
            return repo.removeDetails(row,cutoff,now);
        });
        return removed;
    }
}
