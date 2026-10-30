package com.autumnharvestc.server.execution.scheduling;

import java.util.*;
import org.springframework.http.HttpStatus;
import static com.autumnharvestc.server.execution.agent.AgentRepo.error;

/** Scope defaults and the pure inheritance calculation; persistence and authorization live elsewhere. */
public final class SchedulePolicyValues {
    public static final Set<String> CEILINGS=Set.of("maxSchedules","maxPendingDeliveries","maxQueueTimeoutMs","historyRetentionDays","notificationRetentionDays");
    private SchedulePolicyValues() {}
    public static Map<String,Object> defaults(boolean project) {
        var v=new LinkedHashMap<String,Object>();
        v.put("maxSchedules",project?100L:1000L);v.put("minIntervalMs",60000L);v.put("lateToleranceMs",10000L);
        v.put("misfire","skip");v.put("catchupWindowMs",300000L);v.put("overlap","skip");
        v.put("queueTimeoutMs",300000L);v.put("maxQueueTimeoutMs",3600000L);
        v.put("maxPendingDeliveries",project?100L:1000L);v.put("historyRetentionDays",30L);v.put("notificationRetentionDays",30L);
        return v;
    }
    public static Map<String,Object> merge(Map<String,Object> inherited,Map<String,Object> patch,boolean project,Map<String,String> source,String level) {
        var result=new LinkedHashMap<>(inherited);
        if(project)for(String key:List.of("maxSchedules","maxPendingDeliveries")) {
            long parent=((Number)result.get(key)).longValue();
            if(parent>100){result.put(key,100L);source.put(key,"default");}
        }
        for(var e:patch.entrySet()) {
            String key=e.getKey();Object value=e.getValue();
            if(project&&CEILINGS.contains(key)&&number(value,key)>number(inherited.get(key),key))continue;
            if(project&&key.equals("minIntervalMs")&&number(value,key)<number(inherited.get(key),key))continue;
            result.put(key,value);source.put(key,level);
        }
        if(number(result.get("queueTimeoutMs"),"queueTimeoutMs")>number(result.get("maxQueueTimeoutMs"),"maxQueueTimeoutMs")) {
            result.put("queueTimeoutMs",result.get("maxQueueTimeoutMs"));source.put("queueTimeoutMs",source.get("maxQueueTimeoutMs"));
        }
        return result;
    }
    public static void validate(Map<String,Object> explicit,Map<String,Object> inherited,boolean project,long scanIntervalMs,long maxSchedules,long maxPendingDeliveries) {
        if(explicit==null||!defaults(false).keySet().containsAll(explicit.keySet()))bad("调度策略包含未知字段");
        var values=new LinkedHashMap<>(inherited);values.putAll(explicit);
        for(var e:values.entrySet()) {
            String k=e.getKey();Object v=e.getValue();
            switch(k) {
                case "misfire" -> {if(!"skip".equals(v)&&!"catch-up-one".equals(v))bad("misfire 仅支持 skip/catch-up-one");}
                case "overlap" -> {if(!"skip".equals(v)&&!"queue-one".equals(v))bad("overlap 仅支持 skip/queue-one");}
                case "maxSchedules","maxPendingDeliveries" -> bounded(v,k,1,100000);
                case "historyRetentionDays","notificationRetentionDays" -> bounded(v,k,1,3650);
                case "lateToleranceMs" -> bounded(v,k,1000,300000);
                default -> bounded(v,k,1000,86400000);
            }
        }
        if(number(values.get("maxSchedules"),"maxSchedules")>maxSchedules||number(values.get("maxPendingDeliveries"),"maxPendingDeliveries")>maxPendingDeliveries)bad("额度超过部署上限");
        if(project)for(String k:explicit.keySet()) {
            if(CEILINGS.contains(k)&&number(explicit.get(k),k)>number(inherited.get(k),k))bad(k+" 不得放宽继承上限");
            if(k.equals("minIntervalMs")&&number(explicit.get(k),k)<number(inherited.get(k),k))bad("minIntervalMs 不得低于继承下界");
        }
        if(number(values.get("queueTimeoutMs"),"queueTimeoutMs")>number(values.get("maxQueueTimeoutMs"),"maxQueueTimeoutMs"))bad("默认排队期限不得超过最大值");
        if(number(values.get("lateToleranceMs"),"lateToleranceMs")<2*scanIntervalMs)bad("正常延迟容差不得小于扫描间隔两倍");
    }
    public static long number(Object v,String key) {
        if(!(v instanceof Number n)||!Double.isFinite(n.doubleValue())||n.doubleValue()!=Math.rint(n.doubleValue())||n.doubleValue()<0||n.doubleValue()>9007199254740991L)throw error(HttpStatus.BAD_REQUEST,"validation_failed",key+" 必须是安全整数");
        return ((Number)v).longValue();
    }
    public static void bounded(Object value,String key,long min,long max){long n=number(value,key);if(n<min||n>max)bad(key+" 超出允许范围");}
    private static void bad(String message){throw error(HttpStatus.BAD_REQUEST,"validation_failed",message);}
}
