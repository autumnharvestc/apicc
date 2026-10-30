package com.autumnharvestc.server.execution.scheduling;

public class EmbeddedScheduleDriver implements ScheduleDriver {
    private final ScheduleOccurrenceService occurrences;private final ScheduledJobSubmission submission;private final String ownerId;
    public EmbeddedScheduleDriver(ScheduleOccurrenceService occurrences,ScheduledJobSubmission submission,String ownerId){this.occurrences=occurrences;this.submission=submission;this.ownerId=ownerId;}
    @Override public void tick(){for(var claim:occurrences.scan(ownerId))submission.submit(claim);}
}
