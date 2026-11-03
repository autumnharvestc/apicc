package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.store.UserAccount;
import com.autumnharvestc.server.execution.ExecutionDtos.ProjectAssets;
import com.autumnharvestc.server.execution.assets.ProjectAssetsService;
import com.autumnharvestc.server.execution.jobs.JobRepo;
import com.autumnharvestc.server.execution.agent.AgentService;
import com.autumnharvestc.server.access.Capability;
import com.autumnharvestc.server.core.EntityIds;
import com.autumnharvestc.server.core.ApiException;
import com.autumnharvestc.server.core.Hashes;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import static org.springframework.http.HttpStatus.*;

/** Fixed-byte acquisition only; callers perform remote projection after this transaction returns. */
@Service
@Transactional
public class SourceSnapshotReader {
    private final ProjectAssetsService assets;
    private final JobRepo jobs;
    private final AgentService authority;
    public SourceSnapshotReader(ProjectAssetsService assets,JobRepo jobs,AgentService authority) {
        this.assets=assets;this.jobs=jobs;this.authority=authority;
    }
    public ProjectAssets document(UserAccount actor,String workspace,String project,String revision,String digest,long maxBytes) {
        return assets.readPublicationSource(actor,workspace,project,revision,digest,maxBytes);
    }
    public JobRepo.FixedReport report(UserAccount actor,String workspace,String project,String job,long maxBytes) {
        authority.requireCapability(actor,workspace,project,Capability.HISTORY_READ);
        var fixed=jobs.fixedReport(EntityIds.parse(job),maxBytes,metadata->{
        if(metadata.workspace()!=EntityIds.parse(workspace)||metadata.project()!=EntityIds.parse(project))
            throw new ApiException(FORBIDDEN,"source_scope_mismatch","报告来源不属于当前项目");
        if("expired".equals(metadata.reportState()))throw new ApiException(GONE,"source_report_expired","来源报告保留期已结束");
        if(!"ended".equals(metadata.state())||!"archived".equals(metadata.reportState()))
            throw new ApiException(CONFLICT,"source_report_pending","来源报告尚未完成归档");
        });
        if(fixed.body()==null)throw new ApiException(CONFLICT,"source_report_missing","来源报告正文缺失");
        if(!java.util.Objects.equals(fixed.length(),(long)fixed.body().length))
            throw new ApiException(CONFLICT,"source_length_mismatch","来源报告长度与归档元数据不符");
        if(!Hashes.sha256Hex(fixed.body()).equals(fixed.hash()))
            throw new ApiException(CONFLICT,"source_digest_mismatch","来源报告摘要与归档正文不符");
        return fixed;
    }
}
