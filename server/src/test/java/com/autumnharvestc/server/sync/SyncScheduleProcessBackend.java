package com.autumnharvestc.server.sync;
import com.autumnharvestc.server.execution.scheduling.ScheduleTimeSource;
import java.nio.file.*;
import java.time.Instant;
import org.springframework.context.annotation.*;
/** Test-only OS entry point. Production has no debug clock property or endpoint. */
public class SyncScheduleProcessBackend {
    static Path clockFile;
    @org.springframework.boot.test.context.TestConfiguration static class ProcessClock {
        @Bean @Primary ScheduleTimeSource ownedProcessTime(){return ()->{try{return Instant.parse(Files.readString(clockFile).trim());}catch(Exception error){throw new IllegalStateException("Owned process clock is unavailable",error);}};}
    }
    public static void main(String[] args){clockFile=Path.of(args[0]);new org.springframework.boot.builder.SpringApplicationBuilder(com.autumnharvestc.server.ApiccServerApplication.class,ProcessClock.class).run(java.util.Arrays.copyOfRange(args,1,args.length));}
}
