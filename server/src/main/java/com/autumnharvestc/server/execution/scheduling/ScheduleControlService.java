package com.autumnharvestc.server.execution.scheduling;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.jdbc.core.JdbcTemplate;

@Service
@Transactional
public class ScheduleControlService {
    private final JdbcTemplate jdbc;
    public ScheduleControlService(JdbcTemplate jdbc){this.jdbc=jdbc;}
    public record View(String mode,String generation,String version){}
    public record Update(String mode,String expectedVersion){}
    public View change(Update input){
        if(!"embedded".equals(input.mode())&&!"disabled".equals(input.mode()))throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.BAD_REQUEST,"validation_failed","调度模式仅支持 embedded/disabled");
        var old=lock();long expected=com.autumnharvestc.server.execution.agent.AgentRepo.version(input.expectedVersion());
        if(expected!=Long.parseLong(old.version()))throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.CONFLICT,"version_conflict","调度控制版本已变化");
        if(expected==Long.MAX_VALUE||Long.parseLong(old.generation())==Long.MAX_VALUE)throw com.autumnharvestc.server.execution.agent.AgentRepo.error(org.springframework.http.HttpStatus.CONFLICT,"version_exhausted","调度控制版本或代次已达到上限");
        jdbc.update("UPDATE execution_scheduler_control SET mode=?,generation=generation+1,version=version+1 WHERE id=1 AND version=?",input.mode(),expected);return read();
    }
    public void initialize(String mode){
        var old=lock();
        if(old.mode()!=null&&!old.mode().equals(mode))throw new IllegalStateException("Persistent scheduler.mode differs from deployment; perform an authorized control handoff with expectedVersion before restarting this deployment");
        jdbc.update("UPDATE execution_scheduler_control SET mode=? WHERE id=1 AND mode IS NULL",mode);
    }
    public View read(){return jdbc.queryForObject("SELECT mode,generation,version FROM execution_scheduler_control WHERE id=1",(r,n)->new View(r.getString(1),r.getString(2),r.getString(3)));}
    public View lock(){jdbc.queryForObject("SELECT id FROM execution_scheduler_control WHERE id=1 FOR UPDATE",Long.class);return read();}
}
