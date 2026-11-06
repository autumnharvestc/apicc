package com.autumnharvestc.server.store;

import java.time.Instant;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Database-authoritative UTC for infrastructure leases, independent of replaceable business clocks. */
@Component
public final class DatabaseUtcClock {
    private final JdbcTemplate jdbc;
    public DatabaseUtcClock(JdbcTemplate jdbc){this.jdbc=jdbc;}
    /** H2's non-deterministic alias advances even within a transaction holding a lease.
     * A different database adapter must supply its engine's real statement clock here. */
    public Instant now(){return jdbc.queryForObject("SELECT DATEADD('MILLISECOND', APICC_SCHEDULER_EPOCH_MILLIS(), TIMESTAMP WITH TIME ZONE '1970-01-01 00:00:00+00')",java.time.OffsetDateTime.class).toInstant();}
}
