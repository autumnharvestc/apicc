package com.autumnharvestc.server.collaboration.artifacts;

import com.autumnharvestc.server.collaboration.policy.PolicyReadView.Source;
import com.autumnharvestc.server.collaboration.policy.PolicyReadView;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;

/** Finite effective facts attached only to already authorized collaboration responses. */
public final class ArtifactConstraints {
    private ArtifactConstraints() {}
    public record IntegerFact(Long value,Source source) {}
    public record BooleanFact(Boolean value,Source source) {}
    public record Grant(IntegerFact defaultShareDurationMs,IntegerFact maxShareDurationMs,
            BooleanFact externalSharingAllowed,BooleanFact externalDownloadAllowed) {}
    public record Preview(IntegerFact defaultShareDurationMs,IntegerFact maxShareDurationMs,
            BooleanFact externalSharingAllowed,BooleanFact externalDownloadAllowed,
            IntegerFact maxSourceBytes,IntegerFact maxArtifactBytes,IntegerFact maxFieldBytes,IntegerFact maxEvidenceBytes,
            BooleanFact evidenceAllowed,IntegerFact memberUploadRetentionMs,IntegerFact inactiveArtifactRetentionMs) {}
    private static IntegerFact integer(PolicyReadView policy,PolicyReadView.Code code){
        var value=(PolicyReadView.IntegerSetting)policy.settings().stream().filter(setting->setting.code()==code).findFirst().orElseThrow();
        return new IntegerFact(value.effective(),value.source());
    }
    private static BooleanFact bool(PolicyReadView policy,PolicyReadView.Code code){
        var value=(PolicyReadView.BooleanSetting)policy.settings().stream().filter(setting->setting.code()==code).findFirst().orElseThrow();
        return new BooleanFact(value.effective(),value.source());
    }
    public static Grant grant(PolicyReadView policy){return new Grant(integer(policy,DEFAULT_SHARE_DURATION_MS),integer(policy,MAX_SHARE_DURATION_MS),bool(policy,EXTERNAL_SHARING_ALLOWED),bool(policy,EXTERNAL_DOWNLOAD_ALLOWED));}
    public static Preview preview(PolicyReadView policy){
        var grant=grant(policy);
        return new Preview(grant.defaultShareDurationMs(),grant.maxShareDurationMs(),grant.externalSharingAllowed(),grant.externalDownloadAllowed(),
            integer(policy,MAX_SOURCE_BYTES),integer(policy,MAX_ARTIFACT_BYTES),integer(policy,MAX_FIELD_BYTES),integer(policy,MAX_EVIDENCE_BYTES),
            bool(policy,EVIDENCE_ALLOWED),integer(policy,MEMBER_UPLOAD_RETENTION_MS),integer(policy,INACTIVE_ARTIFACT_RETENTION_MS));
    }
}
