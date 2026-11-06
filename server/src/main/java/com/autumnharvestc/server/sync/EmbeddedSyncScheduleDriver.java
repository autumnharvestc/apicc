package com.autumnharvestc.server.sync;
import org.springframework.stereotype.Component;
@Component
public class EmbeddedSyncScheduleDriver implements SyncScheduleDriver {
    private final SyncOccurrenceService occurrences;
    public EmbeddedSyncScheduleDriver(SyncOccurrenceService occurrences){this.occurrences=occurrences;}
    @Override public void tick(){occurrences.tick();}
}
