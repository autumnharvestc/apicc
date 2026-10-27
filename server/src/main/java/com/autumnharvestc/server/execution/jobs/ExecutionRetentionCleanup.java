package com.autumnharvestc.server.execution.jobs;

import com.autumnharvestc.server.execution.ExecutionProperties;
import com.autumnharvestc.server.execution.config.ExecutionConfigService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import java.time.*;
import java.util.*;

/** Bounded payload reclamation. Intent, assignment, permit and ACK identities are never deleted. */
@Component
@EnableScheduling
public class ExecutionRetentionCleanup {
    private final JdbcTemplate jdbc;
    private final ExecutionProperties properties;
    private final ExecutionConfigService configs;
    private final JobService jobs;
    private long projectCursor;
    public ExecutionRetentionCleanup(JdbcTemplate jdbc,ExecutionProperties properties,ExecutionConfigService configs,JobService jobs){this.jdbc=jdbc;this.properties=properties;this.configs=configs;this.jobs=jobs;}
    private static OffsetDateTime cutoff(OffsetDateTime now,long days){try{return now.minusDays(days);}catch(DateTimeException|ArithmeticException overflow){return OffsetDateTime.parse("0001-01-01T00:00:00Z");}}
    private static final String ELIGIBLE="j.state='ended' AND j.execution_released=TRUE AND j.report_state='archived' AND NOT EXISTS (SELECT 1 FROM execution_job_outbox o WHERE o.job_id=j.id AND o.acknowledged=FALSE)";
    private record Project(long workspace,long id) {}
    @Scheduled(initialDelayString="#{@executionProperties.deployment.cleanupIntervalMs}",fixedDelayString="#{@executionProperties.deployment.cleanupIntervalMs}")
    @Transactional
    public synchronized void cleanup(){
        var now=jobs.now();int batch=properties.getDeployment().getCleanupBatchSize();
        // A legacy row with an unknown archive time receives a new conservative anchor once.
        var unknown=jdbc.query("SELECT id FROM execution_jobs WHERE report_state='archived' AND report_retained_at IS NULL ORDER BY id LIMIT ?",(r,n)->r.getLong(1),batch);
        for(long id:unknown)jdbc.update("UPDATE execution_jobs SET report_retained_at=? WHERE id=? AND report_retained_at IS NULL",now,id);
        var projects=jdbc.query("SELECT j.workspace_id,j.project_id FROM execution_jobs j WHERE "+ELIGIBLE+" AND j.project_id>? AND j.report_retained_at<=? GROUP BY j.workspace_id,j.project_id ORDER BY j.project_id LIMIT ?",(r,n)->new Project(r.getLong(1),r.getLong(2)),projectCursor,cutoff(now,1),batch);
        if(projects.isEmpty()){
            projectCursor=0;
            projects=jdbc.query("SELECT j.workspace_id,j.project_id FROM execution_jobs j WHERE "+ELIGIBLE+" AND j.report_retained_at<=? GROUP BY j.workspace_id,j.project_id ORDER BY j.project_id LIMIT ?",(r,n)->new Project(r.getLong(1),r.getLong(2)),cutoff(now,1),batch);
        }
        int remaining=batch;
        for(var project:projects){
            projectCursor=project.id();
            var policy=(Map<?,?>)configs.effective(null,project.workspace(),project.id(),Map.of()).get("policy");
            var before=cutoff(now,((Number)policy.get("resultRetentionDays")).longValue());
            var ids=jdbc.query("SELECT j.id FROM execution_jobs j WHERE "+ELIGIBLE+" AND j.project_id=? AND j.report_retained_at<=? ORDER BY j.id LIMIT ?",(r,n)->r.getLong(1),project.id(),before,remaining);
            for(long id:ids)remaining-=jdbc.update("UPDATE execution_jobs j SET report_content=NULL,inputs_json='{}',submission_json='{}',report_state='expired' WHERE j.id=? AND "+ELIGIBLE+" AND j.report_retained_at<=?",id,before);
            if(remaining==0)break;
        }
        var audits=jdbc.query("SELECT id FROM execution_management_audit WHERE created_at<=? ORDER BY id LIMIT ?",(r,n)->r.getLong(1),cutoff(now,properties.getDeployment().getAuditRetentionDays()),batch);
        for(long id:audits)jdbc.update("DELETE FROM execution_management_audit WHERE id=? AND created_at<=?",id,cutoff(now,properties.getDeployment().getAuditRetentionDays()));
    }
}
