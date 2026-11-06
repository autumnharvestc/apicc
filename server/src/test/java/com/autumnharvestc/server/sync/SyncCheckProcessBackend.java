package com.autumnharvestc.server.sync;

import com.autumnharvestc.server.ApiccServerApplication;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.*;
import java.util.*;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.test.util.ReflectionTestUtils;

/** Test-only process entry: observes its own bounded work map through owned files, without product endpoints. */
public final class SyncCheckProcessBackend {
    public static void main(String[] args) throws Exception {
        Path directory=Path.of(args[0]);var json=new ObjectMapper();
        var context=new SpringApplicationBuilder(ApiccServerApplication.class).run(Arrays.copyOfRange(args,1,args.length));
        var worker=context.getBean(SyncCheckWorker.class);
        Files.writeString(directory.resolve("ready.json"),json.writeValueAsString(Map.of("pid",ProcessHandle.current().pid())));
        Thread.ofPlatform().daemon().name("owned-sync-test-observer").start(()->{
            String last="";
            while(context.isActive()){
                try{
                    Path query=directory.resolve("work-query.txt");
                    if(Files.exists(query)){
                        String nonce=Files.readString(query).trim();
                        if(nonce.matches("[0-9a-f-]{36}")&&!nonce.equals(last)){
                            var work=(Map<?,?>)ReflectionTestUtils.getField(worker,"work");var checks=new ArrayList<String>();var remaining=new LinkedHashMap<String,Long>();
                            for(var entry:work.entrySet()){
                                var method=entry.getKey().getClass().getDeclaredMethod("check");method.setAccessible(true);String check=(String)method.invoke(entry.getKey());checks.add(check);
                                try{long until=((Number)ReflectionTestUtils.getField(entry.getValue(),"localUntil")).longValue();remaining.put(check,java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(until-System.nanoTime()));}catch(IllegalArgumentException legacy){/* Legacy product has no local ownership lease. */}
                            }
                            Path temporary=directory.resolve("answer-"+nonce+".tmp"),answer=directory.resolve("answer-"+nonce+".json");
                            Files.writeString(temporary,json.writeValueAsString(Map.of("pid",ProcessHandle.current().pid(),"checks",checks,"localLeaseRemainingMs",remaining)));
                            Files.move(temporary,answer,StandardCopyOption.ATOMIC_MOVE);last=nonce;
                        }
                    }
                    Thread.sleep(10);
                }catch(InterruptedException stopped){Thread.currentThread().interrupt();return;}
                catch(Exception failure){try{Thread.sleep(10);}catch(InterruptedException stopped){Thread.currentThread().interrupt();return;}}
            }
        });
    }
}
