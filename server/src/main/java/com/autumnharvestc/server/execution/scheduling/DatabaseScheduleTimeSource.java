package com.autumnharvestc.server.execution.scheduling;

import java.time.Instant;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class DatabaseScheduleTimeSource implements ScheduleTimeSource {
    private final JdbcTemplate jdbc;
    public DatabaseScheduleTimeSource(JdbcTemplate jdbc){this.jdbc=jdbc;}
    /** H2-specific real database time, including within a transaction holding a lease.
     * The fixed non-deterministic alias executes in the DB engine, on the existing connection.
     * A future database adapter must replace ScheduleTimeSource with that engine's statement clock. */
    @Override public Instant now(){return jdbc.queryForObject("SELECT DATEADD('MILLISECOND', APICC_SCHEDULER_EPOCH_MILLIS(), TIMESTAMP WITH TIME ZONE '1970-01-01 00:00:00+00')",java.time.OffsetDateTime.class).toInstant();}
}
