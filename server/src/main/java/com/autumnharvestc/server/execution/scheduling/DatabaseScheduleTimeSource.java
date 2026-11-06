package com.autumnharvestc.server.execution.scheduling;

import java.time.Instant;
import com.autumnharvestc.server.store.DatabaseUtcClock;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class DatabaseScheduleTimeSource implements ScheduleTimeSource {
    private final DatabaseUtcClock clock;
    @Autowired public DatabaseScheduleTimeSource(DatabaseUtcClock clock){this.clock=clock;}
    /** Retains direct JDBC construction for existing callers outside Spring. */
    public DatabaseScheduleTimeSource(JdbcTemplate jdbc){this(new DatabaseUtcClock(jdbc));}
    @Override public Instant now(){return clock.now();}
}
