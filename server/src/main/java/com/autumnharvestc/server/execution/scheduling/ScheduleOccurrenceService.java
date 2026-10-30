package com.autumnharvestc.server.execution.scheduling;

import java.util.*;
import java.time.*;
import org.springframework.stereotype.Service;

@Service
public class ScheduleOccurrenceService {
    private final ScheduleOccurrenceRepo repo;private final ScheduleRepo plans;private final ScheduleTimeSource time;private final SchedulerProperties properties;private final ScheduleRuleCalculator calculator;private final ScheduleControlService control;
    public ScheduleOccurrenceService(ScheduleOccurrenceRepo repo,ScheduleRepo plans,ScheduleTimeSource time,SchedulerProperties properties,ScheduleRuleCalculator calculator,ScheduleControlService control){this.repo=repo;this.plans=plans;this.time=time;this.properties=properties;this.calculator=calculator;this.control=control;}
    public record Claim(String id,String ownerId,String generation,String revision,String cancellationVersion,String leaseUntilUtc) {}
    public record JobLink(String jobId,String executionId){}
    public record SubmissionContext(ScheduleOccurrenceRepo.Row occurrence,ScheduleDtos.Execution execution,com.autumnharvestc.server.execution.ExecutionDtos.MaterialSelection materials,String intentId){}
    public Optional<JobLink> submit(Claim claim,java.util.function.Function<SubmissionContext,JobLink> submission){requireNoAmbientTransaction();try{return transaction.execute(status->{
        var authority=control.lock();var found=repo.find(Long.parseLong(claim.id()),false);if(found.isEmpty())return Optional.empty();var original=found.orElseThrow();repo.lockProject(original.scope());repo.lockSchedule(original.scope());var locked=repo.find(original.id(),true);if(locked.isEmpty())return Optional.empty();var row=locked.orElseThrow();
        if(!submissionFence(claim,authority,row,time.now()))return Optional.empty();
        if(repo.precedingActive(row))return Optional.empty();
        requireLatestSubject(row,authority.generation());
        var execution=plans.decode(repo.execution(row),ScheduleDtos.Execution.class);
        var context=new SubmissionContext(row,execution,plans.decode(row.materials(),com.autumnharvestc.server.execution.ExecutionDtos.MaterialSelection.class),"scheduled-occurrence-"+row.id());
        var link=submission.apply(context);
        if(link==null||!repo.matchingJob(row,link,context.intentId()))throw new IllegalStateException("Scheduled submission must persist the matching job/execution identity in this transaction");
        var committedAt=time.now();if(!submissionFence(claim,control.read(),repo.row(row.id(),true),committedAt)){status.setRollbackOnly();return Optional.empty();}
        repo.link(row,link,committedAt);return Optional.of(link);
    });}catch(OccurrenceRejected rejected){transaction.executeWithoutResult(status->recordOccurrenceRejection(rejected));return Optional.empty();}}
    private boolean submissionFence(Claim claim,ScheduleControlService.View authority,ScheduleOccurrenceRepo.Row row,Instant now){
        if(!"embedded".equals(authority.mode())||!authority.generation().equals(claim.generation())||!Set.of("pending","waiting-overlap").contains(row.state())||!Objects.equals(row.owner(),claim.ownerId())||!Objects.equals(String.valueOf(row.generation()),claim.generation())||row.leaseUntil()==null||!row.leaseUntil().toString().equals(claim.leaseUntilUtc())||!now.isBefore(row.leaseUntil())||!now.isBefore(row.queueDeadline())||!String.valueOf(row.revision()).equals(claim.revision())||!String.valueOf(row.cancellationVersion()).equals(claim.cancellationVersion()))return false;
        var plan=plans.require(row.scope().workspace(),row.scope().project(),row.scope().schedule(),false);
        return plan.enabled()&&plan.revision().equals(claim.revision())&&plan.cancellationVersion().equals(claim.cancellationVersion())&&plan.subjectUserId().equals(String.valueOf(row.subject()));
    }
    /** The original Job callback has fully rolled back before this separately fenced decision. */
    void recordSubmissionFailure(Claim claim,String code){
        requireNoAmbientTransaction();if(code==null||!code.matches("[a-z][a-z0-9_-]{0,95}"))throw new IllegalArgumentException("Unsafe submission reason code");
        transaction.executeWithoutResult(status->{
            var authority=control.lock();var found=repo.find(Long.parseLong(claim.id()),false);if(found.isEmpty())return;var original=found.orElseThrow();repo.lockProject(original.scope());repo.lockSchedule(original.scope());var locked=repo.find(original.id(),true);if(locked.isEmpty())return;var row=locked.orElseThrow();var now=time.now();
            if(!submissionFence(claim,authority,row,now))return;
            if(!code.equals("queue_capacity"))repo.terminal(row.id(),"rejected",code,now);
        });
    }
    @org.springframework.beans.factory.annotation.Autowired private org.springframework.transaction.support.TransactionTemplate transaction;
    @org.springframework.beans.factory.annotation.Autowired private ScheduleGrantService grants;
    @org.springframework.beans.factory.annotation.Autowired private ScheduleService schedules;
    @org.springframework.beans.factory.annotation.Autowired private SchedulePolicyService policy;
    public Optional<Claim> claim(String ownerId,String occurrenceId){requireNoAmbientTransaction();try{return transaction.execute(status->{
        var authority=control.lock();if(!"embedded".equals(authority.mode()))return Optional.empty();
        var found=repo.find(Long.parseLong(occurrenceId),false);if(found.isEmpty())return Optional.empty();var original=found.orElseThrow();repo.lockProject(original.scope());repo.lockSchedule(original.scope());var locked=repo.find(original.id(),true);if(locked.isEmpty())return Optional.empty();var row=locked.orElseThrow();var now=time.now();
        if(!Set.of("pending","waiting-overlap").contains(row.state()))return Optional.empty();
        if(!now.isBefore(row.queueDeadline())){repo.terminal(row.id(),"expired","schedule-queue-expired",now);return Optional.empty();}
        if(row.leaseUntil()!=null&&now.isBefore(row.leaseUntil()))return Optional.empty();
        requireLatestSubject(row,authority.generation());
        if(!repo.take(row,ownerId,Long.parseLong(authority.generation()),now,now.plusMillis(properties.getClaimLeaseMs())))return Optional.empty();
        return Optional.of(new Claim(occurrenceId,ownerId,authority.generation(),String.valueOf(row.revision()),String.valueOf(row.cancellationVersion()),repo.row(row.id(),false).leaseUntil().toString()));
    });}catch(OccurrenceRejected rejected){transaction.executeWithoutResult(status->recordOccurrenceRejection(rejected));return Optional.empty();}}
    public List<Claim> scan(String ownerId) {
        requireNoAmbientTransaction();
        observeReleased();
        var claims=new ArrayList<Claim>();
        for(String recovery:repo.recoverable(time.now(),properties.getBatchSize()))claim(ownerId,recovery).ifPresent(claims::add);
        for(var scope:repo.scheduled(time.now(),properties.getBatchSize()-claims.size())){
            try {var result=transaction.execute(status->admit(scope,ownerId));result.ifPresent(claims::add);}
            catch(AdmissionRejected rejected){transaction.executeWithoutResult(status->recordRejection(scope,rejected,ownerId));}
        }
        return List.copyOf(claims);
    }
    /** Original Job release observation has no trigger/claim/submission authority. */
    public void observeReleased(){
        requireNoAmbientTransaction();
        for(String released:repo.releasedCandidates(properties.getBatchSize()))transaction.executeWithoutResult(status->{
            control.lock();var found=repo.find(Long.parseLong(released),false);if(found.isEmpty())return;var original=found.orElseThrow();repo.lockProject(original.scope());repo.lockSchedule(original.scope());var locked=repo.find(original.id(),true);if(locked.isPresent())repo.observeReleased(locked.orElseThrow(),time.now());
        });
    }
    private Optional<Claim> admit(ScheduleOccurrenceRepo.Scope scope,String owner){
        var authority=control.lock();if(!"embedded".equals(authority.mode()))return Optional.empty();repo.lockProject(scope);repo.lockSchedule(scope);if(!repo.activePlan(scope))return Optional.empty();var plan=plans.require(scope.workspace(),scope.project(),scope.schedule(),false);var now=time.now();
        if(plan.nextPlannedAtUtc()==null||Instant.parse(plan.nextPlannedAtUtc()).isAfter(now))return Optional.empty();
        var at=Instant.parse(plan.nextPlannedAtUtc());
        try{
            var effective=(Map<?,?>)policy.effective(scope.workspace(),scope.project()).get("effective");
            long minInterval=((Number)effective.get("minIntervalMs")).longValue();
            long queueTimeout=Math.min(plan.policies().queueTimeoutMs(),((Number)effective.get("maxQueueTimeoutMs")).longValue());
            if(plan.evaluatedThroughUtc()!=null&&!at.isAfter(Instant.parse(plan.evaluatedThroughUtc()))){var watermark=Instant.parse(plan.evaluatedThroughUtc());var range=calculator.boundedDue(plan.rule(),watermark,watermark.isAfter(now)?watermark:now,minInterval,properties.getEvaluationMaxCandidates());repo.cursor(scope,range.candidates().isEmpty()?range.nextPlannedAtUtc():range.candidates().getFirst().plannedAtUtc());return Optional.empty();}
            boolean late=Duration.between(at,now).toMillis()>plan.policies().lateToleranceMs();
            Instant from=at.minusNanos(1);
            Instant anchor=repo.anchor(scope);if(plan.evaluatedThroughUtc()!=null&&(anchor==null||Instant.parse(plan.evaluatedThroughUtc()).isAfter(anchor)))anchor=Instant.parse(plan.evaluatedThroughUtc());if(anchor!=null&&anchor.isBefore(at))from=anchor;
            if(late){var floor=now.minusMillis(plan.policies().misfire().equals("catch-up-one")?plan.policies().catchupWindowMs():plan.policies().lateToleranceMs()).minusNanos(1);if(floor.isAfter(from))from=floor;}
            var due=calculator.boundedDue(plan.rule(),from,now,minInterval,properties.getEvaluationMaxCandidates());
            if(due.candidates().isEmpty()){
                repo.missed(plan,at,now,now,"schedule-misfire-skipped");repo.closeGap(scope,now,due.nextPlannedAtUtc());return Optional.empty();
            }
            var selected=late&&plan.policies().misfire().equals("catch-up-one")?due.candidates().getLast():due.candidates().getFirst();
            var selectedAt=Instant.parse(selected.plannedAtUtc());
            if(plan.lastAdmittedPlannedAtUtc()!=null)calculator.requireInterval(Instant.parse(plan.lastAdmittedPlannedAtUtc()),selectedAt,minInterval);
            var subject=grants.requireSubject(Long.parseLong(plan.subjectUserId()),scope.workspace(),scope.project());
            var sealed=schedules.sealMaterials(subject,scope.workspace(),scope.project(),plan.execution());
            if(due.calendarNotices().stream().anyMatch(notice->notice.code().equals("dst-gap-skipped")&&!Instant.parse(notice.boundaryUtc()).isAfter(selectedAt)))repo.missed(plan,from.plusMillis(1),selectedAt,now,"dst-gap-skipped");
            if(selectedAt.isAfter(at))repo.missed(plan,at,selectedAt.minusMillis(1),now,late&&plan.policies().misfire().equals("catch-up-one")?"schedule-catchup-gap":"schedule-misfire-skipped");
            long occurrence=repo.insert(plan,selectedAt,now,owner,Long.parseLong(authority.generation()),properties.getClaimLeaseMs(),queueTimeout);repo.seal(occurrence,plans.encode(sealed));
            int selectedIndex=due.candidates().indexOf(selected);String next=selectedIndex+1<due.candidates().size()?due.candidates().get(selectedIndex+1).plannedAtUtc():due.nextPlannedAtUtc();repo.advance(scope,selectedAt,next);
            if(!now.isBefore(selectedAt.plusMillis(queueTimeout))){repo.terminal(occurrence,"expired","schedule-queue-expired",now);return Optional.empty();}
            if(repo.precedingActive(repo.row(occurrence,false))){
                if(plan.policies().overlap().equals("queue-one")&&!repo.hasWaiting(scope))repo.waitForOverlap(occurrence);
                else repo.terminal(occurrence,"skipped","schedule-overlap-skipped",now);
                return Optional.empty();
            }
            return Optional.of(new Claim(String.valueOf(occurrence),owner,authority.generation(),plan.revision(),plan.cancellationVersion(),repo.row(occurrence,false).leaseUntil().toString()));
        }catch(com.autumnharvestc.server.core.ApiException e){throw new AdmissionRejected(plan,at,e.getCode(),authority.generation());}
    }
    private void recordRejection(ScheduleOccurrenceRepo.Scope scope,AdmissionRejected failure,String owner){
        var authority=control.lock();repo.lockProject(scope);repo.lockSchedule(scope);if(!repo.activePlan(scope))return;var plan=plans.require(scope.workspace(),scope.project(),scope.schedule(),false);var now=time.now();
        if(!"embedded".equals(authority.mode())||!authority.generation().equals(failure.generation)||!plan.enabled()||!plan.revision().equals(failure.plan.revision())||!plan.cancellationVersion().equals(failure.plan.cancellationVersion())||!plan.subjectUserId().equals(failure.plan.subjectUserId())||plan.evaluatedThroughUtc()!=null&&!failure.at.isAfter(Instant.parse(plan.evaluatedThroughUtc())))return;
        if(!failure.code.equals("schedule-evaluation-limit")){
            long cap=((Number)((Map<?,?>)policy.effective(scope.workspace(),scope.project()).get("effective")).get("maxQueueTimeoutMs")).longValue();
            long occurrence=repo.insert(plan,failure.at,now,owner,Long.parseLong(authority.generation()),properties.getClaimLeaseMs(),Math.min(plan.policies().queueTimeoutMs(),cap));repo.terminal(occurrence,"rejected",failure.code,now);repo.advance(scope,failure.at,null);
        }
        repo.pause(scope,failure.code);plans.cancelInvalidated(scope.schedule(),now);
    }
    private static class AdmissionRejected extends RuntimeException {
        final ScheduleDtos.View plan;final Instant at;final String code;final String generation;
        AdmissionRejected(ScheduleDtos.View plan,Instant at,String code,String generation){this.plan=plan;this.at=at;this.code=code;this.generation=generation;}
    }
    private void requireLatestSubject(ScheduleOccurrenceRepo.Row row,String generation){try{grants.requireSubject(row.subject(),row.scope().workspace(),row.scope().project());}catch(com.autumnharvestc.server.core.ApiException error){throw new OccurrenceRejected(row,generation,error.getCode());}}
    private void recordOccurrenceRejection(OccurrenceRejected failure){
        var authority=control.lock();var scope=failure.row.scope();repo.lockProject(scope);repo.lockSchedule(scope);var found=repo.find(failure.row.id(),true);if(found.isEmpty())return;var row=found.orElseThrow();
        if(!"embedded".equals(authority.mode())||!authority.generation().equals(failure.generation)||!row.equals(failure.row)||!repo.currentBarrier(row))return;
        var now=time.now();repo.terminal(row.id(),"rejected",failure.code,now);repo.pause(scope,failure.code);plans.cancelInvalidated(scope.schedule(),now);
    }
    private static class OccurrenceRejected extends RuntimeException {
        final ScheduleOccurrenceRepo.Row row;final String generation;final String code;
        OccurrenceRejected(ScheduleOccurrenceRepo.Row row,String generation,String code){this.row=row;this.generation=generation;this.code=code;}
    }
    private static void requireNoAmbientTransaction(){if(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Schedule scan/claim/submit must be called outside an existing transaction");}
}
