package com.autumnharvestc.server.collaboration.publicapi;

import com.autumnharvestc.server.collaboration.grants.GrantService;
import org.springframework.boot.*;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Order(4)
public class GrantStartupReconciler implements ApplicationRunner {
    private final GrantService grants;
    private final PublicAdmissionState admission;
    public GrantStartupReconciler(GrantService grants,PublicAdmissionState admission){this.grants=grants;this.admission=admission;}
    @Override public void run(ApplicationArguments arguments){admission.close();grants.reconcileAppliedDeployment();admission.reconciled();}
}
