package com.autumnharvestc.server.execution.scheduling;

import java.time.*;
import java.util.*;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Component;
import org.springframework.http.HttpStatus;
import static com.autumnharvestc.server.execution.agent.AgentRepo.error;

@Component
public class ScheduleRuleCalculator {
    public record CalendarNotice(String code,String boundaryUtc){}
    public record Due(List<ScheduleDtos.Candidate> candidates,List<String> notices,String nextPlannedAtUtc,List<CalendarNotice> calendarNotices){}
    /** Internal authority window is (after, through]; never accepts a driver-supplied decision time. */
    public Due boundedDue(ScheduleDtos.Rule rule,Instant after,Instant through,long minIntervalMs,int maxCandidates){
        var calendar=new LinkedHashSet<CalendarNotice>();var expanded=calculate(rule,after,minIntervalMs,maxCandidates,Integer.MAX_VALUE,through,calendar);
        if(rule instanceof ScheduleDtos.CronRule&&((Number)expanded.limits().get("evaluatedCandidates")).intValue()==maxCandidates
            &&(expanded.candidates().isEmpty()||!Instant.parse(expanded.candidates().getLast().plannedAtUtc()).isAfter(through)))
            throw error(HttpStatus.BAD_REQUEST,"schedule-evaluation-limit","规则求值预算已用尽，尚未覆盖完整判定窗口");
        var next=expanded.candidates().stream().filter(c->Instant.parse(c.plannedAtUtc()).isAfter(through)).findFirst().map(ScheduleDtos.Candidate::plannedAtUtc).orElse(null);
        return new Due(expanded.candidates().stream().filter(c->!Instant.parse(c.plannedAtUtc()).isAfter(through)).toList(),expanded.notices(),next,List.copyOf(calendar));
    }
    public ScheduleDtos.Preview preview(ScheduleDtos.Rule rule,Instant after,long minIntervalMs,int maxCandidates) {
        return calculate(rule,after,minIntervalMs,maxCandidates,5,null,null);
    }
    private ScheduleDtos.Preview calculate(ScheduleDtos.Rule rule,Instant after,long minIntervalMs,int maxCandidates,int visibleLimit,Instant noticeThrough,Set<CalendarNotice> calendar) {
        if(rule==null||after==null||minIntervalMs<1000||maxCandidates<1)throw invalid("规则、时间与求值预算必填");
        var zone=zone(rule.timeZone());
        var candidates=new ArrayList<ScheduleDtos.Candidate>();
        if(rule instanceof ScheduleDtos.OnceRule once) {
            var at=instant(once.atUtc());
            if(at.isAfter(after))candidates.add(candidate(at,zone));
            return new ScheduleDtos.Preview(List.copyOf(candidates),List.of(),Map.of("minIntervalMs",minIntervalMs,"maxCandidates",maxCandidates));
        }
        var recurring=(ScheduleDtos.CronRule)rule;
        if(recurring.dstOverlap()==null||!Set.of("first","both").contains(recurring.dstOverlap()))throw invalid("dstOverlap 仅支持 first/both");
        CronExpression cron;
        try {
            if(recurring.expression()==null||recurring.expression().trim().split("\\s+").length!=6)throw new IllegalArgumentException();
            cron=CronExpression.parse(recurring.expression());
        }catch(IllegalArgumentException ex){throw invalid("Cron 必须是有效的六字段表达式");}
        var localAfter=after.atZone(zone).toLocalDateTime();
        var cursor=localAfter;
        if(zone.getRules().getValidOffsets(localAfter).size()==2)cursor=zone.getRules().getTransition(localAfter).getDateTimeAfter().minusNanos(1);
        var notices=new LinkedHashSet<String>();
        var instants=new TreeSet<Instant>();
        int evaluated=0;
        // Inspect the bounded horizon, not merely the five visible samples. Admission must recheck every occurrence.
        for(;evaluated<maxCandidates;evaluated++) {
            cursor=cron.next(cursor); if(cursor==null)break;
            var offsets=zone.getRules().getValidOffsets(cursor);
            if(offsets.isEmpty()){
                var boundary=zone.getRules().getTransition(cursor).getInstant();
                if(instants.size()<visibleLimit&&(noticeThrough==null||!boundary.isAfter(noticeThrough))){
                    notices.add("dst-gap-skipped");if(calendar!=null)calendar.add(new CalendarNotice("dst-gap-skipped",boundary.toString()));
                }
                continue;
            }
            if(offsets.size()>1&&instants.size()<visibleLimit&&(noticeThrough==null||!cursor.toInstant(offsets.getFirst()).isAfter(noticeThrough)))notices.add("dst-overlap-"+recurring.dstOverlap());
            int count=recurring.dstOverlap().equals("first")?1:offsets.size();
            for(int i=0;i<count;i++) {
                var at=cursor.toInstant(offsets.get(i));
                if(!at.isAfter(after))continue;
                instants.add(at);
            }
        }
        // Within a fold, later local candidates may precede an already expanded second-offset instant.
        // Until local enumeration exits that fold, neither the UTC prefix nor its validation horizon is closed.
        if(evaluated==maxCandidates&&(instants.size()<5||cursor.isBefore(localAfter)
            ||recurring.dstOverlap().equals("both")&&zone.getRules().getValidOffsets(cursor).size()==2))
            throw error(HttpStatus.BAD_REQUEST,"schedule-evaluation-limit","规则求值预算已用尽");
        Instant previous=null,lastChecked=null;
        for(var at:instants) {
            if(previous!=null)requireInterval(previous,at,minIntervalMs);
            previous=at;lastChecked=at;
            if(candidates.size()<visibleLimit)candidates.add(candidate(at,zone));
        }
        var limits=new LinkedHashMap<String,Object>();limits.put("minIntervalMs",minIntervalMs);limits.put("maxCandidates",maxCandidates);
        limits.put("evaluatedCandidates",evaluated);limits.put("admissionRecheckRequired",true);
        if(lastChecked!=null)limits.put("validatedThroughUtc",lastChecked.toString());
        return new ScheduleDtos.Preview(List.copyOf(candidates),List.copyOf(notices),limits);
    }
    /** T3 must call against the durable last admitted planned instant, within its admission transaction. */
    public void requireInterval(Instant previous,Instant next,long minIntervalMs) {
        if(!next.isAfter(previous)||Duration.between(previous,next).compareTo(Duration.ofMillis(minIntervalMs))<0)
            throw error(HttpStatus.BAD_REQUEST,"schedule-interval-too-short","触发间隔小于有效最小间隔");
    }
    public static Instant instant(String value) {
        try {if(value==null||!value.endsWith("Z"))throw new IllegalArgumentException();return Instant.parse(value);}
        catch(Exception ex){throw invalid("时间必须是 ISO UTC Instant");}
    }
    public static ZoneId zone(String value) {
        try {if(value==null||!ZoneId.getAvailableZoneIds().contains(value))throw new IllegalArgumentException();return ZoneId.of(value);}
        catch(Exception ex){throw invalid("时区必须是显式 IANA ZoneId");}
    }
    private static ScheduleDtos.Candidate candidate(Instant at,ZoneId zone) {
        var local=at.atZone(zone);
        return new ScheduleDtos.Candidate(at.toString(),local.toLocalDateTime().format(java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS")),local.getOffset().toString());
    }
    private static com.autumnharvestc.server.core.ApiException invalid(String message){return error(HttpStatus.BAD_REQUEST,"validation_failed",message);}
}
