package com.autumnharvestc.server.execution.scheduling;

import com.autumnharvestc.server.execution.jobs.*;
import com.autumnharvestc.server.store.UserRepo;
import java.util.Optional;
import org.springframework.stereotype.Service;

/** Delegates without holding an ambient transaction; the original Job joins the occurrence transaction. */
@Service
public class ScheduledJobSubmission {
    private final ScheduleOccurrenceService occurrences;private final JobService jobs;private final UserRepo users;
    public ScheduledJobSubmission(ScheduleOccurrenceService occurrences,JobService jobs,UserRepo users){this.occurrences=occurrences;this.jobs=jobs;this.users=users;}
    public Optional<ScheduleOccurrenceService.JobLink> submit(ScheduleOccurrenceService.Claim claim){
        try{return occurrences.submit(claim,context->{
            var row=context.occurrence();var e=context.execution();
            var request=new JobDtos.Submit(context.intentId(),e.agentId(),e.snapshotId(),e.target(),e.environmentId(),null,e.runConfig(),context.materials(),e.preparation(),e.network());
            var job=jobs.submitScheduled(users.findById(row.subject()).orElseThrow(),String.valueOf(row.scope().workspace()),String.valueOf(row.scope().project()),request,row.queueDeadline(),new JobRepo.ScheduleOrigin(row.id(),row.scope().schedule(),row.revision()));
            return new ScheduleOccurrenceService.JobLink((String)job.get("jobId"),(String)job.get("executionId"));
        });}catch(com.autumnharvestc.server.core.ApiException rejected){occurrences.recordSubmissionFailure(claim,rejected.getCode());return Optional.empty();}
    }
}
